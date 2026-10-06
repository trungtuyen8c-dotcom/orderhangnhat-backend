import { Router, type Request } from "express";
import { AppError } from "../../app/errors/AppError.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize, hasPermission } from "../../middlewares/authorize.js";
import * as orders from "./order.service.js";
import { parseOrderListQuery } from "./order.listFilter.js";
import { ORDER_ACTIONS, type OrderAction } from "./order.state.js";
import { consignSchema, correctionSchema, createSchema, editSchema, fixSchema, paySchema, statusSchema } from "./order.validation.js";

export { findWrongMarketplaceUrl } from "./order.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticateEither);

const actor = (req: Request): orders.Actor => ({ id: req.user!.id, roles: req.user!.roles, requestId: req.requestId });
const q = (v: unknown) => String(v ?? "").trim();
const canUpdateStatus = (req: Request) => hasPermission(req, "orders.update_status");

// ?page=&pageSize= opt-in -> { items, pagination }; không có page -> mảng như cũ nhưng tối đa 500 đơn mới nhất.
// Lọc (cả 2 chế độ): source|exclude, q, status, excludeStatus, nick, paymentMethod (__empty__ = chưa có),
// tracking=has|none, paid=yes|no, customerId, from/to (YYYY-MM-DD, giờ VN), month=YYYY-MM|latest,
// sort=orderDate|code|totalVnd|createdAt + order=asc|desc. summary=1 (khi có page) -> thêm `summary`.
ordersRouter.get("/", authorize("orders.list"), asyncHandler(async (req, res) => {
  const { filter, sort } = parseOrderListQuery(req.query);
  const withSummary = req.query.summary === "1" || req.query.summary === "true";
  res.json(await orders.listOrders(filter, sort, readPage(req), { withSummary, canUpdateStatus: await canUpdateStatus(req) }));
}));

// Giá trị cho ô lọc Nick / PTTT (thay cho việc FE tự gom từ toàn bộ đơn).
ordersRouter.get("/facets", authorize("orders.list"), asyncHandler(async (req, res) => {
  res.json(await orders.listFacets(String(req.query.source ?? ""), String(req.query.exclude ?? "")));
}));

// Đơn bị kế toán yêu cầu sửa, chưa xử lý xong -> hiện chuông thông báo cho sale
ordersRouter.get("/fix-requests", authorize("orders.update"), asyncHandler(async (_req, res) => {
  res.json(await orders.listFixRequests());
}));

// Tra đơn theo mã - dùng để gán tracking lạ (chưa khớp đơn) vào đúng đơn
ordersRouter.get("/lookup-code", authorize("orders.list"), asyncHandler(async (req, res) => {
  res.json(await orders.lookupCode(q(req.query.code)));
}));

// Cảnh báo trùng link sản phẩm / mã tracking với đơn khác - để sale tự xác nhận trước khi lưu, không tự chặn.
ordersRouter.get("/check-duplicate", authorize("orders.list"), asyncHandler(async (req, res) => {
  res.json(await orders.checkDuplicate(q(req.query.url), q(req.query.code), q(req.query.excludeOrderId)));
}));

// Bước được bấm từ trạng thái hiện tại (lọc theo quyền người gọi) + canCorrect cho admin.
ordersRouter.get("/:id/transitions", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await orders.getTransitions(req.params.id, await canUpdateStatus(req), actor(req)));
}));

ordersRouter.get("/:id", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await orders.getOrderDetail(req.params.id));
}));

ordersRouter.post("/", authorize("orders.create"), asyncHandler(async (req, res) => {
  const d = parseOr400(createSchema, req.body);
  res.status(201).json(await orders.createOrder(d, actor(req)));
}));

ordersRouter.post("/consignment", authorize("orders.create"), asyncHandler(async (req, res) => {
  const d = parseOr400(consignSchema, req.body);
  res.status(201).json(await orders.createConsignment(d, actor(req)));
}));

ordersRouter.patch("/:id/status", authorize("orders.update_status"), asyncHandler(async (req, res) => {
  const { status } = parseOr400(statusSchema, req.body);
  res.json(await orders.changeStatus(req.params.id, status, actor(req)));
}));

ordersRouter.patch("/:id", authorize("orders.update"), asyncHandler(async (req, res) => {
  const d = parseOr400(editSchema, req.body);
  res.json(await orders.editOrder(req.params.id, d, actor(req)));
}));

ordersRouter.post("/:id/pay", authorize("orders.update"), asyncHandler(async (req, res) => {
  const d = parseOr400(paySchema, req.body);
  await orders.payLaterOrder(req.params.id, d, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/unpay", authorize("orders.update"), asyncHandler(async (req, res) => {
  await orders.unpayLaterOrder(req.params.id, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/request-fix", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  const p = fixSchema.safeParse(req.body);
  if (!p.success) throw new AppError("BAD_REQUEST", 400, "Nhập nội dung yêu cầu sửa");
  await orders.requestFix(req.params.id, p.data.note, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/resolve-fix", authorize("orders.update"), asyncHandler(async (req, res) => {
  await orders.resolveFix(req.params.id, actor(req));
  res.json({ ok: true });
}));

ordersRouter.delete("/:id", authorize("orders.delete"), asyncHandler(async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  await orders.deleteOrder(req.params.id, force, actor(req));
  res.json({ ok: true });
}));

// Admin/super_admin sửa sai trạng thái (bất kỳ trạng thái) - bắt buộc lý do, có audit.
ordersRouter.post("/:id/status-correction", authorize("orders.update_status"), asyncHandler(async (req, res) => {
  const p = correctionSchema.safeParse(req.body);
  if (!p.success) throw new AppError("BAD_REQUEST", 400, "Chọn trạng thái và nhập lý do (tối thiểu 5 ký tự)");
  res.json(await orders.correctOrderStatus(req.params.id, p.data.status, p.data.reason, actor(req)));
}));

// Chuyển bước theo bảng trạng thái. Đăng ký SAU mọi route POST /:id/... khác; param bị khoá vào đúng danh sách
// bước nên không bao giờ nuốt /:id/pay, /:id/unpay, /:id/request-fix, /:id/resolve-fix, /:id/status-correction.
const ACTION_PATH = `/:id/:action(${ORDER_ACTIONS.join("|")})`;
ordersRouter.post(ACTION_PATH, authorize("orders.update_status"), asyncHandler(async (req, res) => {
  res.json(await orders.transitionOrder(req.params.id, req.params.action as OrderAction, actor(req)));
}));
