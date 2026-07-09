import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { syncCustomerOrders } from "../../utils/gsheets.js";

// 着払い gắn tracking -> đơn/khách -> gọi sau khi tạo/xóa khoản để công nợ + sheet khách cập nhật/trừ lại ngay.
async function resyncTracking(trackingId: string): Promise<void> {
  const t = await prisma.tracking.findUnique({ where: { id: trackingId }, select: { orderId: true } });
  if (!t?.orderId) return;
  await recomputeOrderTotals(t.orderId);
  const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } });
  if (o) void syncCustomerOrders(o.customerId);
}

export const companyCostRouter = Router();
companyCostRouter.use(authenticate);

const mk = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const KIND_LABEL: Record<string, string> = { chakubarai: "着払い (hàng trả sau)", weight: "Tiền cân tháng", other: "Khác" };

async function reinforceUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: "reinforce_price_vnd" } });
  return Number(c?.value ?? 30000);
}

// Báo cáo phải trả kho/cty theo tháng
companyCostRouter.get("/report", authorize("companycost.view"), async (req, res) => {
  const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : mk(new Date());
  const unit = await reinforceUnit();

  // Gia cố/check: đếm đơn needsCheck có tracking đóng hàng trong tháng
  const checkTrks = await prisma.tracking.findMany({
    where: { packedAt: { not: null }, order: { needsCheck: true } },
    select: { packedAt: true, orderId: true },
  });
  const reinforceOrders = new Set<string>();
  for (const t of checkTrks) if (t.packedAt && mk(t.packedAt) === month && t.orderId) reinforceOrders.add(t.orderId);
  const reinforceCount = reinforceOrders.size;
  const reinforceVnd = reinforceCount * unit;

  // Entry nhập tay (chakubarai, weight, other)
  const entries = await prisma.companyCost.findMany({ where: { month }, orderBy: { createdAt: "desc" } });
  // Khoản 着払い gắn tracking -> tra ngược đơn/khách để hiện cho biết đã tính vào công nợ ai
  const trkIds = entries.filter((e) => e.kind === "chakubarai" && e.refId).map((e) => e.refId as string);
  const trks = trkIds.length
    ? await prisma.tracking.findMany({ where: { id: { in: trkIds } }, select: { id: true, code: true, order: { select: { code: true, customer: { select: { name: true } } } } } })
    : [];
  const trkMap = new Map(trks.map((t) => [t.id, t]));
  const ser = entries.map((e) => {
    const trk = e.refId ? trkMap.get(e.refId) : undefined;
    return {
      id: e.id, kind: e.kind, kindLabel: KIND_LABEL[e.kind] ?? e.kind, amountVnd: Number(e.amountVnd),
      currency: e.currency, amountOrig: Number(e.amountOrig), exchangeRate: e.exchangeRate ? Number(e.exchangeRate) : null,
      note: e.note, paid: e.paid, createdAt: e.createdAt,
      trackingCode: trk?.code ?? null, orderCode: trk?.order?.code ?? null, customerName: trk?.order?.customer?.name ?? null,
    };
  });
  const byKind: Record<string, number> = { reinforce: reinforceVnd };
  for (const e of ser) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amountVnd;
  const totalVnd = reinforceVnd + ser.reduce((s, e) => s + e.amountVnd, 0);
  const paidVnd = ser.filter((e) => e.paid).reduce((s, e) => s + e.amountVnd, 0);

  res.json({
    month, reinforceCount, reinforceUnit: unit, reinforceVnd,
    entries: ser, byKind, totalVnd, paidVnd, unpaidVnd: totalVnd - paidVnd,
  });
});

const entrySchema = z.object({
  kind: z.enum(["chakubarai", "weight", "other"]),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  note: z.string().optional(),
  // Kho báo tracking + giá 着払い -> gắn thẳng vào đúng đơn/khách của mã đó, tự cộng vào công nợ (chỉ áp dụng kind=chakubarai)
  trackingCode: z.string().optional(),
});
companyCostRouter.post("/", authorize("accounting.record_payment"), async (req, res) => {
  const p = entrySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (p.data.currency === "JPY" && !p.data.exchangeRate) return res.status(400).json({ error: "BAD_REQUEST", message: "Nhập JPY cần tỉ giá" });
  const amountVnd = p.data.currency === "JPY" ? Math.round(p.data.amount * p.data.exchangeRate!) : p.data.amount;

  let refId: string | null = null;
  const code = p.data.trackingCode?.trim();
  if (p.data.kind === "chakubarai" && code) {
    const trk = await prisma.tracking.findFirst({ where: { code }, select: { id: true, orderId: true } });
    if (!trk) return res.status(400).json({ error: "BAD_REQUEST", message: "Không tìm thấy mã tracking này" });
    if (!trk.orderId) return res.status(400).json({ error: "BAD_REQUEST", message: "Mã tracking chưa gắn đơn nào" });
    refId = trk.id;
  }

  const c = await prisma.companyCost.create({ data: {
    id: uuid(), kind: p.data.kind, month: p.data.month, amountVnd, currency: p.data.currency,
    amountOrig: p.data.amount, exchangeRate: p.data.exchangeRate ?? null, note: p.data.note ?? null, refId,
  } });
  if (refId) await resyncTracking(refId);
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "company_cost.created", metadata: { kind: c.kind, amountVnd, refId } });
  res.status(201).json(c);
});

companyCostRouter.patch("/:id/paid", authorize("accounting.record_payment"), async (req, res) => {
  const c = await prisma.companyCost.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "NOT_FOUND" });
  const updated = await prisma.companyCost.update({ where: { id: c.id }, data: { paid: !c.paid } });
  res.json(updated);
});

companyCostRouter.delete("/:id", authorize("accounting.record_payment"), async (req, res) => {
  const c = await prisma.companyCost.findUnique({ where: { id: req.params.id } });
  await prisma.companyCost.delete({ where: { id: req.params.id } });
  // Gắn tracking (着払い) -> xóa khoản này phải tự trừ lại công nợ + sheet khách, không được giữ nguyên số cũ.
  if (c?.refId) await resyncTracking(c.refId);
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "company_cost.deleted" });
  res.json({ ok: true });
});

// Cấu hình đơn giá gia cố
companyCostRouter.get("/reinforce-price", authorize("companycost.view"), async (_req, res) => {
  res.json({ unit: await reinforceUnit() });
});
companyCostRouter.put("/reinforce-price", authorize("system.manage_settings"), async (req, res) => {
  const p = z.object({ unit: z.number().nonnegative() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await prisma.appConfig.upsert({ where: { key: "reinforce_price_vnd" }, update: { value: String(p.data.unit) }, create: { key: "reinforce_price_vnd", value: String(p.data.unit) } });
  res.json({ unit: p.data.unit });
});
