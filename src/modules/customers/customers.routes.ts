import { Router, type Request } from "express";
import { AppError } from "../../app/errors/AppError.js";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as svc from "./customers.service.js";

export const customersRouter = Router();
customersRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });

// Không gửi ?page= -> mảng như cũ (tối đa 500); có ?page=&pageSize= -> { items, pagination }.
// q = tìm tên/SĐT/mã KH/FB-Zalo; sort=createdAt|name|code + order=asc|desc; lite=1 -> chỉ { id, code, name }.
customersRouter.get("/", authorize("customers.list"), asyncHandler(async (req, res) => {
  const sort = String(req.query.sort ?? "");
  const order = String(req.query.order ?? "");
  if (sort && !["createdAt", "name", "code"].includes(sort)) throw new AppError("BAD_REQUEST", 400, "sort không hợp lệ");
  if (order && !["asc", "desc"].includes(order)) throw new AppError("BAD_REQUEST", 400, "order không hợp lệ");
  const lq = {
    q: String(req.query.q ?? "").trim() || undefined,
    sort: (sort || undefined) as svc.CustomerSortField | undefined,
    dir: (order || undefined) as "asc" | "desc" | undefined,
  };
  res.json(await svc.listCustomers(readPage(req), lq, { lite: req.query.lite === "1" || req.query.lite === "true" }));
}));

const schema = z.object({
  name: z.string().min(1),
  fbZalo: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  sheetUrl: z.string().nullable().optional(),
  shipRatePerKg: z.number().nonnegative().nullable().optional(),
  skipVnWeighingDefault: z.boolean().optional(),
});

customersRouter.post("/", authorize("customers.create"), asyncHandler(async (req, res) => {
  const body = parseOr400(schema, req.body);
  res.status(201).json(await svc.createCustomer(body, actor(req)));
}));

customersRouter.patch("/:id", authorize("customers.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(schema.partial(), req.body);
  res.json(await svc.updateCustomer(req.params.id, body, actor(req)));
}));

// Đẩy lại toàn bộ đơn + sổ cọc cũ vào sheet khách (dùng khi mới đổi link sheet)
customersRouter.post("/:id/sync-sheet", authorize("customers.update"), asyncHandler(async (req, res) => {
  res.json(await svc.resyncSheet(req.params.id));
}));

customersRouter.delete("/:id", authorize("customers.delete"), asyncHandler(async (req, res) => {
  res.json(await svc.deleteCustomer(req.params.id, actor(req)));
}));
