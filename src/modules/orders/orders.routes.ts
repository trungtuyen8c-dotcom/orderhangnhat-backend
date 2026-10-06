import { Router, type Request } from "express";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as orders from "./order.service.js";
import { consignSchema, createSchema, editSchema, fixSchema, paySchema, statusSchema } from "./order.validation.js";

export { findWrongMarketplaceUrl } from "./order.service.js";

export const ordersRouter = Router();
ordersRouter.use(authenticateEither);

const actor = (req: Request): orders.Actor => ({ id: req.user!.id, roles: req.user!.roles, requestId: req.requestId });
const q = (v: unknown) => String(v ?? "").trim();

// ?page=&pageSize= opt-in -> { items, pagination }; không có page -> mảng như cũ.
ordersRouter.get("/", authorize("orders.list"), handle(async (req, res) => {
  res.json(await orders.listOrders({ source: String(req.query.source ?? ""), exclude: String(req.query.exclude ?? "") }, readPage(req)));
}));

// Đơn bị kế toán yêu cầu sửa, chưa xử lý xong -> hiện chuông thông báo cho sale
ordersRouter.get("/fix-requests", authorize("orders.update"), handle(async (_req, res) => {
  res.json(await orders.listFixRequests());
}));

// Tra đơn theo mã - dùng để gán tracking lạ (chưa khớp đơn) vào đúng đơn
ordersRouter.get("/lookup-code", authorize("orders.list"), handle(async (req, res) => {
  res.json(await orders.lookupCode(q(req.query.code)));
}));

// Cảnh báo trùng link sản phẩm / mã tracking với đơn khác - để sale tự xác nhận trước khi lưu, không tự chặn.
ordersRouter.get("/check-duplicate", authorize("orders.list"), handle(async (req, res) => {
  res.json(await orders.checkDuplicate(q(req.query.url), q(req.query.code), q(req.query.excludeOrderId)));
}));

ordersRouter.get("/:id", authorize("orders.read"), handle(async (req, res) => {
  res.json(await orders.getOrderDetail(req.params.id));
}));

ordersRouter.post("/", authorize("orders.create"), handle(async (req, res) => {
  const d = parseOr400(createSchema, req.body);
  res.status(201).json(await orders.createOrder(d, actor(req)));
}));

ordersRouter.post("/consignment", authorize("orders.create"), handle(async (req, res) => {
  const d = parseOr400(consignSchema, req.body);
  res.status(201).json(await orders.createConsignment(d, actor(req)));
}));

ordersRouter.patch("/:id/status", authorize("orders.update_status"), handle(async (req, res) => {
  const { status } = parseOr400(statusSchema, req.body);
  res.json(await orders.changeStatus(req.params.id, status, actor(req)));
}));

ordersRouter.patch("/:id", authorize("orders.update"), handle(async (req, res) => {
  const d = parseOr400(editSchema, req.body);
  res.json(await orders.editOrder(req.params.id, d, actor(req)));
}));

ordersRouter.post("/:id/pay", authorize("orders.update"), handle(async (req, res) => {
  const d = parseOr400(paySchema, req.body);
  await orders.payLaterOrder(req.params.id, d, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/unpay", authorize("orders.update"), handle(async (req, res) => {
  await orders.unpayLaterOrder(req.params.id, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/request-fix", authorize("accounting.reconcile"), handle(async (req, res) => {
  const p = fixSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST", message: "Nhập nội dung yêu cầu sửa" });
  await orders.requestFix(req.params.id, p.data.note, actor(req));
  res.json({ ok: true });
}));

ordersRouter.post("/:id/resolve-fix", authorize("orders.update"), handle(async (req, res) => {
  await orders.resolveFix(req.params.id, actor(req));
  res.json({ ok: true });
}));

ordersRouter.delete("/:id", authorize("orders.delete"), handle(async (req, res) => {
  const force = req.query.force === "1" || req.query.force === "true";
  await orders.deleteOrder(req.params.id, force, actor(req));
  res.json({ ok: true });
}));
