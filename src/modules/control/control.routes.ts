import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const controlRouter = Router();
controlRouter.use(authenticate);

const effKg = (t: { jpWeightKg: unknown; vnWeightKg: unknown }) =>
  t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);

// ===== Kiện / carton: đối soát cân =====
controlRouter.get("/cartons", authorize("trackings.list"), async (_req, res) => {
  const cartons = await prisma.carton.findMany({
    orderBy: { createdAt: "desc" },
    include: { trackings: { select: { id: true, code: true, jpWeightKg: true, vnWeightKg: true, order: { select: { code: true } } } } },
  });
  const rows = cartons.map((c) => {
    const actualKg = c.trackings.reduce((s, t) => s + effKg(t), 0);
    const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : null;
    return {
      id: c.id, code: c.code, note: c.note,
      declaredWeightKg: declared, actualKg, count: c.trackings.length,
      diffKg: declared != null ? actualKg - declared : null,
      trackings: c.trackings,
    };
  });
  res.json(rows);
});

const cartonSchema = z.object({ code: z.string().min(1), declaredWeightKg: z.number().nonnegative().optional(), packedDate: z.string().optional(), note: z.string().optional() });
controlRouter.post("/cartons", authorize("trackings.update"), async (req, res) => {
  const p = cartonSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const c = await prisma.carton.create({ data: { id: uuid(), code: p.data.code, declaredWeightKg: p.data.declaredWeightKg ?? null, packedDate: p.data.packedDate ? new Date(p.data.packedDate) : null, note: p.data.note ?? null } });
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "carton.created" });
  res.status(201).json(c);
});

controlRouter.patch("/cartons/:id", authorize("trackings.update"), async (req, res) => {
  const p = cartonSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const { packedDate, ...rest } = p.data;
  const c = await prisma.carton.update({ where: { id: req.params.id }, data: { ...rest, ...(packedDate !== undefined ? { packedDate: packedDate ? new Date(packedDate) : null } : {}) } });
  res.json(c);
});

controlRouter.delete("/cartons/:id", authorize("trackings.update"), async (req, res) => {
  // Đánh dấu manual để không bị sync kho tự gán lại (tạo lại) kiện vừa xóa ngay sau đó.
  await prisma.tracking.updateMany({ where: { cartonId: req.params.id }, data: { cartonId: null, cartonManual: true } });
  await prisma.carton.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "carton.deleted" });
  res.json({ ok: true });
});

// Gán tracking vào kiện theo mã (dán nhiều mã, mỗi dòng 1 mã)
const assignSchema = z.object({ codes: z.array(z.string().min(1)).min(1) });
controlRouter.post("/cartons/:id/assign", authorize("trackings.update"), async (req, res) => {
  const p = assignSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const carton = await prisma.carton.findUnique({ where: { id: req.params.id } });
  if (!carton) return res.status(404).json({ error: "NOT_FOUND" });
  const codes = p.data.codes.map((c) => c.trim()).filter(Boolean);
  const r = await prisma.tracking.updateMany({ where: { code: { in: codes } }, data: { cartonId: carton.id, cartonManual: true } });
  res.json({ assigned: r.count });
});

// ===== Tracking về VN chưa khớp đơn =====
controlRouter.get("/unmatched", authorize("trackings.list"), async (_req, res) => {
  const rows = await prisma.tracking.findMany({
    where: { orderId: null },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, review: true, createdAt: true },
  });
  res.json(rows);
});

// ===== Công nợ quá hạn / ngưỡng =====
async function getDebtConfig() {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: ["debt_threshold_vnd", "debt_overdue_days"] } } });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return { thresholdVnd: Number(m.get("debt_threshold_vnd") ?? 0), overdueDays: Number(m.get("debt_overdue_days") ?? 30) };
}
controlRouter.get("/debt-config", authorize("orders.read"), async (_req, res) => {
  res.json(await getDebtConfig());
});
const debtCfgSchema = z.object({ thresholdVnd: z.number().nonnegative(), overdueDays: z.number().int().nonnegative() });
controlRouter.put("/debt-config", authorize("system.manage_settings"), async (req, res) => {
  const p = debtCfgSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await prisma.appConfig.upsert({ where: { key: "debt_threshold_vnd" }, update: { value: String(p.data.thresholdVnd) }, create: { key: "debt_threshold_vnd", value: String(p.data.thresholdVnd) } });
  await prisma.appConfig.upsert({ where: { key: "debt_overdue_days" }, update: { value: String(p.data.overdueDays) }, create: { key: "debt_overdue_days", value: String(p.data.overdueDays) } });
  res.json(p.data);
});

async function overdueDebts() {
  const cfg = await getDebtConfig();
  const [debtAgg, orders, customers] = await Promise.all([
    prisma.debt.groupBy({ by: ["customerId"], where: { currency: "VND" }, _sum: { balance: true } }),
    prisma.order.findMany({ where: { status: { not: "cancelled" } }, select: { customerId: true, createdAt: true } }),
    prisma.customer.findMany({ select: { id: true, name: true, code: true, phone: true } }),
  ]);
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const oldest = new Map<string, Date>();
  for (const o of orders) { const cur = oldest.get(o.customerId); if (!cur || o.createdAt < cur) oldest.set(o.customerId, o.createdAt); }
  const now = Date.now();
  const list = debtAgg.map((g) => {
    const balance = Number(g._sum.balance ?? 0);
    const od = oldest.get(g.customerId);
    const days = od ? Math.floor((now - new Date(od).getTime()) / 86400000) : 0;
    return { customerId: g.customerId, name: cmap.get(g.customerId)?.name ?? "?", code: cmap.get(g.customerId)?.code ?? null, phone: cmap.get(g.customerId)?.phone ?? null, balance, days };
  }).filter((r) => r.balance > 0 && (r.balance >= cfg.thresholdVnd || r.days >= cfg.overdueDays))
    .sort((a, b) => b.balance - a.balance);
  return { cfg, list };
}
controlRouter.get("/overdue-debts", authorize("orders.read"), async (_req, res) => {
  res.json(await overdueDebts());
});

// ===== Hàng "Lưu kho" nằm quá lâu chưa ship =====
async function getStorageConfig() {
  const row = await prisma.appConfig.findUnique({ where: { key: "storage_overdue_days" } });
  return { overdueDays: Number(row?.value ?? 7) };
}
controlRouter.get("/storage-config", authorize("warehouse.weigh_vn"), async (_req, res) => {
  res.json(await getStorageConfig());
});
const storageCfgSchema = z.object({ overdueDays: z.number().int().positive() });
controlRouter.put("/storage-config", authorize("system.manage_settings"), async (req, res) => {
  const p = storageCfgSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await prisma.appConfig.upsert({ where: { key: "storage_overdue_days" }, update: { value: String(p.data.overdueDays) }, create: { key: "storage_overdue_days", value: String(p.data.overdueDays) } });
  res.json(p.data);
});
async function storageOverdueCount(): Promise<number> {
  const cfg = await getStorageConfig();
  const cut = new Date(Date.now() - cfg.overdueDays * 86400000);
  return prisma.tracking.count({ where: { status: "stored", packedAt: { lt: cut }, OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], NOT: { order: { externalWarehouse: true } } } });
}

// ===== Trung tâm kiểm soát: gom số đếm =====
controlRouter.get("/overview", authorize("orders.read"), async (_req, res) => {
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [lateOrders, notReviewed, pendingDeposits, unmatched, missingPrice, cartons, overdue, storageOverdue, lateAfterLock, taxPending] = await Promise.all([
    prisma.order.count({ where: { status: { not: "cancelled" }, trackings: { none: {} }, createdAt: { lt: weekAgo } } }),
    prisma.tracking.count({ where: { review: null, orderId: { not: null } } }),
    prisma.customerDeposit.count({ where: { confirmed: false } }),
    prisma.tracking.count({ where: { orderId: null } }),
    // totalVnd=null cũng xảy ra khi khách trả thẳng ¥ (chưa có tỉ giá, cố ý) -> không tính là thiếu giá.
    // Chỉ đếm đơn thật sự chưa điền đơn giá món hàng (unitPriceJpy=0).
    prisma.order.count({ where: { status: { not: "cancelled" }, items: { some: { unitPriceJpy: 0 } } } }),
    prisma.carton.findMany({ where: { declaredWeightKg: { not: null } }, include: { trackings: { select: { jpWeightKg: true, vnWeightKg: true } } } }),
    overdueDebts(),
    storageOverdueCount(),
    prisma.tracking.count({ where: { lateAfterLock: true } }),
    // Từng khớp dòng vàng "cần lấy thuế" (needsTax) nhưng chưa tick "Đã lấy thuế" - cảnh báo dồn nhiều chuyến chưa thu.
    prisma.tracking.count({ where: { needsTax: true, taxCollected: false } }),
  ]);
  const cartonMismatch = cartons.filter((c) => {
    const actual = c.trackings.reduce((s, t) => s + effKg(t), 0);
    return Math.abs(actual - Number(c.declaredWeightKg)) > 0.1;
  }).length;
  res.json({
    lateOrders, notReviewed, pendingDeposits, unmatched, missingPrice, cartonMismatch,
    overdueDebts: overdue.list.length, storageOverdue, lateAfterLock, taxPending,
  });
});
