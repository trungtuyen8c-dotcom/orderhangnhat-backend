import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { scrapeProduct } from "../scrape/scrape.service.js";
import * as svc from "./tracking.service.js";

export const trackingRouter = Router();
trackingRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });

const assignVnSchema = z.object({ ids: z.array(z.string().uuid()).min(1), vnTrackingCode: z.string().min(1) });
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
});
const bulkSchema = z.object({ items: z.array(z.object({ orderCode: z.string().min(1), code: z.string().min(1) })).min(1) });
const invSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
// Kho Nhật: quét ra tên + giá + cân
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
  status: z.string().optional(),
  taxCollected: z.boolean().optional(),
  // Ngày xác nhận khách ĐÃ THỰC NHẬN hàng (khác deliveredAt = ngày tạo mã vận đơn nội địa) - set tay qua nút riêng.
  customerReceivedAt: z.coerce.date().nullable().optional(),
});
const resolveSchema = z.object({
  orderId: z.string().uuid().nullable().optional(),
  code: z.string().optional(),
  reason: z.string().min(1),
});

// Lấy tên + giá ¥ từ link sản phẩm - giữ path cũ, dùng chung logic với GET /scrape.
trackingRouter.get("/scrape", authorize("trackings.create"), handle(async (req, res) => {
  res.json(await scrapeProduct(String(req.query.url || "")));
}));

// Mặc định trả mảng (tối đa 500); gửi ?page= thì trả { items, pagination }.
// Lọc: orderId, stock=1, customer (tên khách), q (mã/tên JP/mã đơn/tên khách), status (a,b);
// sort=createdAt|code + order=asc|desc (mặc định createdAt desc).
trackingRouter.get("/", authorize("trackings.list"), handle(async (req, res) => {
  const sortField = String(req.query.sort ?? "") || "createdAt";
  const dir = String(req.query.order ?? "") || "desc";
  if (!["createdAt", "code"].includes(sortField) || !["asc", "desc"].includes(dir))
    return res.status(400).json({ error: "BAD_REQUEST", message: "sort/order không hợp lệ" });
  const status = String(req.query.status ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  res.json(await svc.listTrackings({
    orderId: req.query.orderId ? String(req.query.orderId) : undefined,
    stock: req.query.stock === "1",
    customer: String(req.query.customer ?? "").trim() || undefined,
    q: String(req.query.q ?? "").trim() || undefined,
    status: status.length ? status : undefined,
  }, readPage(req, 100, 500), { field: sortField as "createdAt" | "code", dir: dir as "asc" | "desc" }));
}));

trackingRouter.get("/lookup-code", authorize("trackings.create"), handle(async (req, res) => {
  res.json(await svc.lookupOrderCodeByTracking(String(req.query.code ?? "").trim()));
}));

trackingRouter.post("/assign-vn", authorize("trackings.update"), handle(async (req, res) => {
  const body = parseOr400(assignVnSchema, req.body);
  res.json(await svc.assignVnTracking(body.ids, body.vnTrackingCode, actor(req)));
}));

trackingRouter.post("/backfill", authorize("trackings.create"), handle(async (_req, res) => {
  res.json(await svc.backfillEmptyTrackings());
}));

trackingRouter.post("/bulk", authorize("trackings.update"), handle(async (req, res) => {
  const body = parseOr400(bulkSchema, req.body);
  res.json(await svc.bulkAssign(body.items, actor(req)));
}));

trackingRouter.post("/invoice", authorize("trackings.list"), handle(async (req, res) => {
  const body = parseOr400(invSchema, req.body);
  res.json(await svc.buildInvoice(body.ids));
}));

trackingRouter.post("/", authorize("trackings.create"), handle(async (req, res) => {
  const body = parseOr400(createSchema, req.body);
  res.status(201).json(await svc.createTracking(body, actor(req)));
}));

trackingRouter.patch("/:id", authorize("trackings.update"), handle(async (req, res) => {
  const body = parseOr400(updateSchema, req.body);
  res.json(await svc.updateTracking(req.params.id, body, actor(req)));
}));

trackingRouter.post("/:id/resolve", authorize("trackings.resolve"), handle(async (req, res) => {
  const body = parseOr400(resolveSchema, req.body);
  res.json(await svc.resolveTracking(req.params.id, body, actor(req)));
}));

trackingRouter.delete("/:id", authorize("trackings.delete"), handle(async (req, res) => {
  await svc.deleteTracking(req.params.id, actor(req));
  res.json({ ok: true });
}));
