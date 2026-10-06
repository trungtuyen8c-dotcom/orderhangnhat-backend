import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as payroll from "./payroll.service.js";

export const payrollRouter = Router();
payrollRouter.use(authenticate);

// Chỉ super_admin xem/sửa lương
payrollRouter.use((req, res, next) => {
  if (!req.user!.roles.includes("super_admin")) return res.status(403).json({ error: "FORBIDDEN", message: "Chỉ super admin" });
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

payrollRouter.get("/", handle(async (req, res) => {
  const month = typeof req.query.month === "string" && MONTH_RE.test(req.query.month) ? req.query.month : undefined;
  res.json(await payroll.listPayroll(month));
}));

// Danh sách nhân viên để chọn
payrollRouter.get("/users", handle(async (_req, res) => {
  res.json(await payroll.listStaff());
}));

payrollRouter.post("/", handle(async (req, res) => {
  const body = parseOr400(schema, req.body);
  res.status(201).json(await payroll.createPayroll(body, actor(req)));
}));

payrollRouter.patch("/:id/paid", handle(async (req, res) => {
  res.json(await payroll.togglePaid(req.params.id, actor(req)));
}));

payrollRouter.delete("/:id", handle(async (req, res) => {
  await payroll.deletePayroll(req.params.id, actor(req));
  res.json({ ok: true });
}));
