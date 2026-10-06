import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../app/errors/AppError.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as cartons from "../cartons/carton.service.js";
import * as svc from "./warehouse.service.js";

export const warehouseRouter = Router();

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId, roles: req.user!.roles });

// Webhook cho Apps Script (KHÔNG qua JWT) — xác thực bằng key bí mật. Đặt TRƯỚC authenticate.
// Key: header X-Warehouse-Webhook-Key (khuyến nghị) | ?key= / X-Hook-Key (Apps Script hiện tại vẫn gửi).
warehouseRouter.post("/sync-hook", asyncHandler(async (req, res) => {
  const keys = [req.query.key, req.headers["x-warehouse-webhook-key"], req.headers["x-hook-key"]]
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  res.json(await svc.handleSyncHook(keys, req.body));
}));

warehouseRouter.use(authenticateEither);

const vnWeighSchema = z.object({ vnWeightKg: z.number().nonnegative().optional(), vnTrackingCode: z.string().optional(), jpWeightKg: z.number().nonnegative().optional() });
const vnTotalSchema = z.object({ vnTotalWeightKg: z.number().nonnegative().nullable() });
const electronicsSchema = z.object({ electronicsCount: z.number().int().nonnegative().nullable() });
const storeSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
const addManualSchema = z.object({ orderCode: z.string().min(1), code: z.string().min(1), jpWeightKg: z.number().nonnegative().optional(), cartonId: z.string().uuid().optional() });
const packCfgSchema = z.object({ sheetUrl: z.string().nullable().optional() });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dayLockSchema = z.object({ date: z.string().regex(DATE_RE) });
const vnTrackSchema = z.object({ trackingId: z.string().uuid(), vnTrackingCode: z.string().min(1) });
const jpSchema = z.object({ trackingId: z.string().uuid(), jpWeightKg: z.number().nonnegative() });
const vnSchema = z.object({ orderId: z.string().uuid(), vnWeight: z.number().nonnegative(), note: z.string().optional() });

const customerQuery = (req: Request) => String(req.query.customer ?? "").trim() || undefined;

warehouseRouter.get("/vn-board", authorize("trackings.list"), asyncHandler(async (req, res) => {
  res.json(await svc.getVnBoard(customerQuery(req)));
}));

// Cân VN + Tracking VN (nội địa) — quyền warehouse.weigh_vn; sửa cân JP thì cần thêm trackings.update (kiểm trong service).
warehouseRouter.patch("/tracking/:id/vn", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(vnWeighSchema, req.body);
  res.json(await svc.weighVn(req.params.id, body, actor(req)));
}));

warehouseRouter.patch("/cartons/:id/vn-total", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(vnTotalSchema, req.body);
  res.json(await cartons.setVnTotalWeight(req.params.id, body.vnTotalWeightKg, actor(req)));
}));

warehouseRouter.post("/cartons/:id/confirm-weight", authorize("trackings.update"), asyncHandler(async (req, res) => {
  res.json(await cartons.confirmWeight(req.params.id, actor(req)));
}));

warehouseRouter.patch("/cartons/:id/electronics", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(electronicsSchema, req.body);
  res.json(await cartons.setElectronicsCount(req.params.id, body.electronicsCount));
}));

warehouseRouter.post("/cartons/:id/confirm-electronics", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  res.json(await cartons.confirmElectronics(req.params.id, actor(req)));
}));

warehouseRouter.post("/store", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(storeSchema, req.body);
  res.json(await svc.storeTrackings(body.ids, actor(req)));
}));

warehouseRouter.get("/stored", authorize("warehouse.weigh_vn", "warehouse.stored.read"), asyncHandler(async (req, res) => {
  res.json(await svc.listStored(customerQuery(req)));
}));

// Tra cứu kho VN: toàn bộ tracking từng qua kho (đã ship lẫn chưa ship), lọc theo ngày lưu kho / mã tracking VN / mã tracking Nhật.
// Khác /stored (chỉ hàng CHƯA ship) - đây là lịch sử tra cứu, không giới hạn trạng thái.
warehouseRouter.get("/history", authorize("warehouse.weigh_vn", "warehouse.history.read"), asyncHandler(async (req, res) => {
  res.json(await svc.searchHistory({
    date: String(req.query.date ?? "").trim() || undefined,
    vnTrackingCode: String(req.query.vnTrackingCode ?? "").trim() || undefined,
    code: String(req.query.code ?? "").trim() || undefined,
  }));
}));

// Thêm tracking tay vào kiện — chỉ sale/buyer/admin (trackings.create), Kho VN KHÔNG có quyền này vì là việc nội bộ gán đơn.
warehouseRouter.post("/tracking", authorize("trackings.create"), asyncHandler(async (req, res) => {
  const body = parseOr400(addManualSchema, req.body);
  res.status(201).json(await svc.addManualTracking(body, actor(req)));
}));

warehouseRouter.delete("/tracking/:id", authorize("trackings.delete"), asyncHandler(async (req, res) => {
  await svc.removeFromVnWarehouse(req.params.id, actor(req));
  res.json({ ok: true });
}));

warehouseRouter.get("/pack-config", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  res.json(await svc.getPackConfig(`${req.protocol}://${req.get("host")}`));
}));

warehouseRouter.put("/pack-config", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  const body = parseOr400(packCfgSchema, req.body);
  res.json(await svc.setPackConfig(body.sheetUrl, actor(req)));
}));

warehouseRouter.post("/sync-pack", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  res.json(await svc.syncPackNow(actor(req)));
}));

// Đọc (không sửa) - mở cho shipments.list dùng để lọc "Cần lấy thuế" theo ngày chuyến/chốt hải quan.
warehouseRouter.get("/day-locks", authorize("shipments.list"), asyncHandler(async (_req, res) => {
  res.json(await svc.listDayLocks());
}));

warehouseRouter.post("/day-locks", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  const body = parseOr400(dayLockSchema, req.body);
  res.status(201).json(await svc.lockDay(body.date, actor(req)));
}));

warehouseRouter.delete("/day-locks/:date", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  if (!DATE_RE.test(req.params.date)) throw new AppError("BAD_REQUEST", 400);
  await svc.unlockDay(req.params.date, actor(req));
  res.json({ ok: true });
}));

// Danh sách tracking quét sau khi ngày đã chốt - cần khai bổ sung hải quan riêng
warehouseRouter.get("/late-after-lock", authorize("system.manage_settings"), asyncHandler(async (_req, res) => {
  res.json(await svc.listLateAfterLock());
}));

warehouseRouter.post("/late-after-lock/:id/resolve", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  await svc.resolveLateAfterLock(req.params.id);
  res.json({ ok: true });
}));

// Kho VN: nhập mã tracking nội địa VN cho 1 tracking
warehouseRouter.post("/vn-tracking", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(vnTrackSchema, req.body);
  res.json(await svc.setVnTrackingCode(body.trackingId, body.vnTrackingCode, actor(req)));
}));

// Cân Nhật: cập nhật cân cho tracking
warehouseRouter.post("/jp-weight", authorize("warehouse.weigh_jp"), asyncHandler(async (req, res) => {
  const body = parseOr400(jpSchema, req.body);
  res.json(await svc.setJpWeight(body.trackingId, body.jpWeightKg, actor(req)));
}));

// Cân VN + đối soát chênh cân (so với tổng cân Nhật của đơn)
warehouseRouter.post("/vn-weight", authorize("warehouse.weigh_vn"), asyncHandler(async (req, res) => {
  const body = parseOr400(vnSchema, req.body);
  res.status(201).json(await svc.reconcileOrderWeight(body, actor(req)));
}));

warehouseRouter.get("/recon", authorize("warehouse.weigh_vn", "warehouse.recon.read"), asyncHandler(async (_req, res) => {
  res.json(await svc.listRecon());
}));
