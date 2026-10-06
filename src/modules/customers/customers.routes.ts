import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as svc from "./customers.service.js";

export const customersRouter = Router();
customersRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });

// Không gửi ?page= -> mảng như cũ; có ?page=&pageSize= -> { items, pagination }.
customersRouter.get("/", authorize("customers.list"), handle(async (req, res) => {
  res.json(await svc.listCustomers(readPage(req)));
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

customersRouter.post("/", authorize("customers.create"), handle(async (req, res) => {
  const body = parseOr400(schema, req.body);
  res.status(201).json(await svc.createCustomer(body, actor(req)));
}));

customersRouter.patch("/:id", authorize("customers.update"), handle(async (req, res) => {
  const body = parseOr400(schema.partial(), req.body);
  res.json(await svc.updateCustomer(req.params.id, body, actor(req)));
}));

// Đẩy lại toàn bộ đơn + sổ cọc cũ vào sheet khách (dùng khi mới đổi link sheet)
customersRouter.post("/:id/sync-sheet", authorize("customers.update"), handle(async (req, res) => {
  res.json(await svc.resyncSheet(req.params.id));
}));

customersRouter.delete("/:id", authorize("customers.delete"), handle(async (req, res) => {
  res.json(await svc.deleteCustomer(req.params.id, actor(req)));
}));
