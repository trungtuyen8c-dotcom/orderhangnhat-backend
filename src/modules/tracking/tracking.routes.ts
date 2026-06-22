import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { scrapeItem, isAllowedUrl } from "../../utils/scrape.js";

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
  const where = req.query.orderId ? { orderId: String(req.query.orderId) } : {};
  const rows = await prisma.tracking.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  res.json(rows);
});

const createSchema = z.object({
  orderId: z.string().uuid().optional(),
  code: z.string().min(1),
  jpName: z.string().optional(),
  jpPriceJpy: z.number().nonnegative().optional(),
  jpWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
});

// NV mua điền tracking
trackingRouter.post("/", authorize("trackings.create"), async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.create({ data: { id: uuid(), ...p.data, status: p.data.orderId ? "linked" : "new" } });
  if (t.orderId) await recomputeOrderTotals(t.orderId);
  await logAudit({ actorId: req.user!.id, targetId: t.id, action: "tracking.created", metadata: { code: t.code } });
  res.status(201).json(t);
});

// Kho Nhật: quét ra tên + giá + cân, gán chuyến
const updateSchema = z.object({
  jpName: z.string().optional(),
  jpPriceJpy: z.number().nonnegative().optional(),
  jpWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
  shipmentId: z.string().uuid().optional(),
  status: z.string().optional(),
});

trackingRouter.patch("/:id", authorize("trackings.update"), async (req, res) => {
  const p = updateSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.update({ where: { id: req.params.id }, data: p.data });
  if (t.orderId) await recomputeOrderTotals(t.orderId);
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
  for (const oid of new Set([old.orderId, updated.orderId].filter(Boolean) as string[])) await recomputeOrderTotals(oid);
  res.json(updated);
});

trackingRouter.delete("/:id", authorize("trackings.delete"), async (req, res) => {
  const t = await prisma.tracking.findUnique({ where: { id: req.params.id } });
  await prisma.trackingLog.deleteMany({ where: { trackingId: req.params.id } });
  await prisma.tracking.delete({ where: { id: req.params.id } });
  if (t?.orderId) await recomputeOrderTotals(t.orderId);
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "tracking.deleted" });
  res.json({ ok: true });
});
