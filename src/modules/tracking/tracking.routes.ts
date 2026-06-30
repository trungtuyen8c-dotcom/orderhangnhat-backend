import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { scrapeItem, isAllowedUrl } from "../../utils/scrape.js";
import { syncTracking, removeTrackingRow, syncCustomerOrders } from "../../utils/gsheets.js";

export const trackingRouter = Router();
trackingRouter.use(authenticate);

// Lấy tên + giá ¥ từ link sản phẩm (Yahoo Flea/Auctions, Mercari)
trackingRouter.get("/scrape", authorize("trackings.create"), async (req, res) => {
  const url = String(req.query.url || "");
  if (!isAllowedUrl(url)) return res.status(400).json({ error: "BAD_URL", message: "Chỉ hỗ trợ link Yahoo / Mercari" });
  try {
    const data = await scrapeItem(url);
    if (!data.name && data.priceJpy == null) return res.status(422).json({ error: "NOT_FOUND", message: "Không lấy được tên/giá, nhập tay" });
    res.json(data);
  } catch {
    res.status(502).json({ error: "FETCH_FAILED", message: "Không tải được trang" });
  }
});

trackingRouter.get("/", authorize("trackings.list"), async (req, res) => {
  const where: any = {};
  if (req.query.orderId) where.orderId = String(req.query.orderId);
  if (req.query.shipmentId) where.shipmentId = String(req.query.shipmentId);
  // Tồn kho = đã về kho (packedAt) nhưng chưa có tracking VN (chưa đóng đi VN)
  if (req.query.stock === "1") { where.packedAt = { not: null }; where.OR = [{ vnTrackingCode: null }, { vnTrackingCode: "" }]; }
  const rows = await prisma.tracking.findMany({
    where, orderBy: { createdAt: "desc" }, take: 500,
    include: { carton: { select: { code: true } }, order: { select: { code: true, needsCheck: true, checkNote: true, customer: { select: { name: true } }, items: { select: { url: true } } } } },
  });
  res.json(rows);
});

// Gộp: gán 1 mã tracking VN cho nhiều kiện hàng (rời khỏi tồn kho)
const assignVnSchema = z.object({ ids: z.array(z.string().uuid()).min(1), vnTrackingCode: z.string().min(1) });
trackingRouter.post("/assign-vn", authorize("trackings.update"), async (req, res) => {
  const p = assignVnSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await prisma.tracking.updateMany({ where: { id: { in: p.data.ids } }, data: { vnTrackingCode: p.data.vnTrackingCode.trim(), status: "vn_received" } });
  const trks = await prisma.tracking.findMany({ where: { id: { in: p.data.ids } }, select: { orderId: true, order: { select: { customerId: true } } } });
  const customers = new Set(trks.map((t) => t.order?.customerId).filter(Boolean) as string[]);
  for (const c of customers) void syncCustomerOrders(c);
  await logAudit({ actorId: req.user!.id, action: "tracking.assign_vn", metadata: { count: p.data.ids.length, vn: p.data.vnTrackingCode } });
  res.json({ assigned: p.data.ids.length });
});

const createSchema = z.object({
  orderId: z.string().uuid().optional(),
  code: z.string().min(1),
  jpName: z.string().optional(),
  jpPriceJpy: z.number().nonnegative().optional(),
  jpWeightKg: z.number().nonnegative().optional(),
  vnWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
  shipRateCurrency: z.enum(["VND", "JPY"]).optional(),
  vnTrackingCode: z.string().optional(),
  url: z.string().optional(),
  packedAt: z.coerce.date().optional(),
  cartonId: z.string().uuid().optional(),
  shipmentId: z.string().uuid().optional(),
});

// Backfill: tạo 1 tracking trống cho mọi đơn chưa có tracking (đơn cũ)
trackingRouter.post("/backfill", authorize("trackings.create"), async (_req, res) => {
  const orders = await prisma.order.findMany({ where: { status: { not: "cancelled" }, trackings: { none: {} } }, select: { id: true } });
  if (orders.length) await prisma.tracking.createMany({ data: orders.map((o) => ({ id: uuid(), orderId: o.id, code: "", status: "linked" })) });
  res.json({ created: orders.length });
});

// Dán nhiều: gán mã tracking theo mã đơn (mỗi dòng "JA10017<tab>code")
const bulkSchema = z.object({ items: z.array(z.object({ orderCode: z.string().min(1), code: z.string().min(1) })).min(1) });
trackingRouter.post("/bulk", authorize("trackings.update"), async (req, res) => {
  const p = bulkSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  let updated = 0, created = 0;
  const notFound: string[] = [];
  const customers = new Set<string>();
  for (const it of p.data.items) {
    const order = await prisma.order.findUnique({ where: { code: it.orderCode.trim() }, select: { id: true, customerId: true } });
    if (!order) { notFound.push(it.orderCode); continue; }
    const empty = await prisma.tracking.findFirst({ where: { orderId: order.id, code: "" } });
    if (empty) { await prisma.tracking.update({ where: { id: empty.id }, data: { code: it.code.trim() } }); updated++; }
    else { await prisma.tracking.create({ data: { id: uuid(), orderId: order.id, code: it.code.trim(), status: "linked" } }); created++; }
    customers.add(order.customerId);
    await recomputeOrderTotals(order.id);
  }
  for (const c of customers) void syncCustomerOrders(c);
  await logAudit({ actorId: req.user!.id, action: "tracking.bulk_assign", metadata: { updated, created, notFound: notFound.length } });
  res.json({ updated, created, notFound });
});

// Gom dữ liệu hóa đơn (invoice) từ các tracking được chọn
const invSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
trackingRouter.post("/invoice", authorize("trackings.list"), async (req, res) => {
  const p = invSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const trks = await prisma.tracking.findMany({ where: { id: { in: p.data.ids } }, include: { order: { include: { items: true, customer: true } } } });
  const orders = new Map<string, (typeof trks)[number]["order"]>();
  for (const t of trks) if (t.order) orders.set(t.order.id, t.order);
  const items: { no: number; name: string; origin: string; unitPriceJpy: number; unit: string; qty: number; amount: number }[] = [];
  let no = 1, total = 0;
  for (const o of orders.values()) {
    for (const it of o!.items) {
      const amount = it.qty * Number(it.unitPriceJpy);
      items.push({ no: no++, name: it.name, origin: "", unitPriceJpy: Number(it.unitPriceJpy), unit: "pcs", qty: it.qty, amount });
      total += amount;
    }
  }
  const consignees = [...new Set([...orders.values()].map((o) => o!.customer?.name).filter(Boolean))] as string[];
  const addresses = [...new Set([...orders.values()].map((o) => o!.customer?.address).filter(Boolean))] as string[];
  res.json({ items, total, consignees, addresses });
});

// NV mua điền tracking
trackingRouter.post("/", authorize("trackings.create"), async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.create({ data: { id: uuid(), ...p.data, status: p.data.orderId ? "linked" : "new" } });
  if (t.orderId) { await recomputeOrderTotals(t.orderId); const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } }); if (o) void syncCustomerOrders(o.customerId); }
  await logAudit({ actorId: req.user!.id, targetId: t.id, action: "tracking.created", metadata: { code: t.code } });
  void syncTracking(t);
  res.status(201).json(t);
});

// Kho Nhật: quét ra tên + giá + cân, gán chuyến
const updateSchema = z.object({
  code: z.string().optional(),
  jpName: z.string().optional(),
  jpPriceJpy: z.number().nonnegative().optional(),
  jpWeightKg: z.number().nonnegative().optional(),
  vnWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
  shipRateCurrency: z.enum(["VND", "JPY"]).optional(),
  vnTrackingCode: z.string().optional(),
  cartonId: z.string().uuid().nullable().optional(),
  review: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  packedAt: z.coerce.date().nullable().optional(),
  docCapturedAt: z.coerce.date().nullable().optional(),
  shipmentId: z.string().uuid().optional(),
  status: z.string().optional(),
});

trackingRouter.patch("/:id", authorize("trackings.update"), async (req, res) => {
  const p = updateSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.update({ where: { id: req.params.id }, data: p.data });
  if (t.orderId) { await recomputeOrderTotals(t.orderId); const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } }); if (o) void syncCustomerOrders(o.customerId); }
  void syncTracking(t);
  res.json(t);
});

// Xử lý tracking lạ / không khớp: sửa + ghi log
const resolveSchema = z.object({
  orderId: z.string().uuid().nullable().optional(),
  code: z.string().optional(),
  reason: z.string().min(1),
});

trackingRouter.post("/:id/resolve", authorize("trackings.resolve"), async (req, res) => {
  const p = resolveSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const old = await prisma.tracking.findUnique({ where: { id: req.params.id } });
  if (!old) return res.status(404).json({ error: "NOT_FOUND" });

  const updated = await prisma.tracking.update({
    where: { id: old.id },
    data: {
      orderId: p.data.orderId === undefined ? old.orderId : p.data.orderId,
      code: p.data.code ?? old.code,
      status: "resolved",
    },
  });
  await prisma.trackingLog.create({
    data: {
      trackingId: old.id,
      actorId: req.user!.id,
      oldValue: { orderId: old.orderId, code: old.code, status: old.status },
      newValue: { orderId: updated.orderId, code: updated.code, status: updated.status },
      reason: p.data.reason,
    },
  });
  await logAudit({ actorId: req.user!.id, targetId: old.id, action: "tracking.resolved", metadata: { reason: p.data.reason } });
  // cập nhật tổng cả đơn cũ lẫn đơn mới nếu gán lại
  for (const oid of new Set([old.orderId, updated.orderId].filter(Boolean) as string[])) {
    await recomputeOrderTotals(oid);
    const o = await prisma.order.findUnique({ where: { id: oid }, select: { customerId: true } });
    if (o) void syncCustomerOrders(o.customerId);
  }
  void syncTracking(updated);
  res.json(updated);
});

trackingRouter.delete("/:id", authorize("trackings.delete"), async (req, res) => {
  const t = await prisma.tracking.findUnique({ where: { id: req.params.id } });
  await prisma.trackingLog.deleteMany({ where: { trackingId: req.params.id } });
  await prisma.tracking.delete({ where: { id: req.params.id } });
  if (t?.orderId) { await recomputeOrderTotals(t.orderId); const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } }); if (o) void syncCustomerOrders(o.customerId); }
  void removeTrackingRow(req.params.id);
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "tracking.deleted" });
  res.json({ ok: true });
});
