import { Router, type Request } from "express";
import { AppError } from "../../app/errors/AppError.js";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as payroll from "./payroll.service.js";

export const payrollRouter = Router();
payrollRouter.use(authenticate);

// Chỉ super_admin xem/sửa lương
payrollRouter.use((req, res, next) => {
  if (!req.user!.roles.includes("super_admin")) return next(new AppError("FORBIDDEN", 403, "Chỉ super admin"));
  next();
});

const MONTH_RE = /^\d{4}-\d{2}$/;
const actor = (req: Request) => ({ id: req.user!.id, requestId: req.requestId });

const schema = z.object({
  userId: z.string().uuid().optional(),
  name: z.string().min(1),
  month: z.string().regex(MONTH_RE),
  amountVnd: z.number().nonnegative(),
  note: z.string().optional(),
});

payrollRouter.get("/", asyncHandler(async (req, res) => {
  const month = typeof req.query.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : undefined;
  res.json(await payroll.listPayroll(month));
}));

// Danh sách nhân viên để chọn
payrollRouter.get("/users", asyncHandler(async (_req, res) => {
  res.json(await payroll.listStaff());
}));

payrollRouter.post("/", asyncHandler(async (req, res) => {
  const body = parseOr400(schema, req.body);
  res.status(201).json(await payroll.createPayroll(body, actor(req)));
}));

payrollRouter.patch("/:id/paid", asyncHandler(async (req, res) => {
  res.json(await payroll.togglePaid(req.params.id, actor(req)));
}));

payrollRouter.delete("/:id", asyncHandler(async (req, res) => {
  await payroll.deletePayroll(req.params.id, actor(req));
  res.json({ ok: true });
}));
