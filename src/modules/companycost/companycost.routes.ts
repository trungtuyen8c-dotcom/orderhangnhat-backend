import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as svc from "./companycost.service.js";

export const companyCostRouter = Router();
companyCostRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });

// Báo cáo phải trả kho/cty theo tháng
companyCostRouter.get("/report", authorize("companycost.view"), handle(async (req, res) => {
  res.json(await svc.report(svc.monthOrCurrent(req.query.month)));
}));

// Đối soát cân theo ngày (kho Nhật khai báo vs VN nhập tay)
companyCostRouter.get("/settlement", authorize("companycost.view"), handle(async (req, res) => {
  res.json(await svc.settlement(svc.monthOrCurrent(req.query.month)));
}));

const entrySchema = z.object({
  kind: z.enum(["chakubarai", "weight", "other"]),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  note: z.string().optional(),
  // Kho báo tracking + giá 着払い -> gắn thẳng vào đúng đơn/khách của mã đó, tự cộng vào công nợ (chỉ áp dụng kind=chakubarai)
  trackingCode: z.string().optional(),
  // Thay thế cho trackingCode khi không nhớ đúng mã tracking - chỉ dùng được nếu đơn đó có ĐÚNG 1 tracking.
  orderCode: z.string().optional(),
});
companyCostRouter.post("/", authorize("accounting.record_payment"), handle(async (req, res) => {
  const body = parseOr400(entrySchema, req.body);
  res.status(201).json(await svc.createEntry(body, actor(req)));
}));

companyCostRouter.patch("/:id/paid", authorize("accounting.record_payment"), handle(async (req, res) => {
  res.json(await svc.togglePaid(req.params.id));
}));

companyCostRouter.delete("/:id", authorize("accounting.record_payment"), handle(async (req, res) => {
  res.json(await svc.deleteEntry(req.params.id, actor(req)));
}));

const unitSchema = z.object({ unit: z.number().nonnegative() });

// Cấu hình đơn giá gia cố
companyCostRouter.get("/reinforce-price", authorize("companycost.view"), handle(async (_req, res) => {
  res.json({ unit: await svc.reinforceUnit() });
}));
companyCostRouter.put("/reinforce-price", authorize("system.manage_settings"), handle(async (req, res) => {
  res.json(await svc.setReinforceUnit(parseOr400(unitSchema, req.body).unit));
}));

// Cấu hình đơn giá phụ thu điện tử
companyCostRouter.get("/electronics-price", authorize("companycost.view"), handle(async (_req, res) => {
  res.json({ unit: await svc.electronicsUnit() });
}));
companyCostRouter.put("/electronics-price", authorize("system.manage_settings"), handle(async (req, res) => {
  res.json(await svc.setElectronicsUnit(parseOr400(unitSchema, req.body).unit));
}));
