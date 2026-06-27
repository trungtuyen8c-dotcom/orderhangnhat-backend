import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { logAudit } from "../../utils/audit.js";

export const payrollRouter = Router();
payrollRouter.use(authenticate);

// Chỉ super_admin xem/sửa lương
payrollRouter.use((req, res, next) => {
  if (!req.user!.roles.includes("super_admin")) return res.status(403).json({ error: "FORBIDDEN", message: "Chỉ super admin" });
  next();
});

payrollRouter.get("/", async (req, res) => {
  const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
  const rows = await prisma.payroll.findMany({ where: month ? { month } : {}, orderBy: [{ month: "desc" }, { name: "asc" }] });
  const totalVnd = rows.reduce((s, r) => s + Number(r.amountVnd), 0);
  const paidVnd = rows.filter((r) => r.paid).reduce((s, r) => s + Number(r.amountVnd), 0);
  res.json({ rows, totalVnd, paidVnd, unpaidVnd: totalVnd - paidVnd });
});

// Danh sách nhân viên để chọn
payrollRouter.get("/users", async (_req, res) => {
  const users = await prisma.user.findMany({ select: { id: true, fullName: true, email: true }, orderBy: { email: "asc" } });
  res.json(users.map((u) => ({ id: u.id, name: u.fullName ?? u.email, email: u.email })));
});

const schema = z.object({
  userId: z.string().uuid().optional(),
  name: z.string().min(1),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amountVnd: z.number().nonnegative(),
  note: z.string().optional(),
});
payrollRouter.post("/", async (req, res) => {
  const p = schema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const r = await prisma.payroll.create({ data: { id: uuid(), userId: p.data.userId ?? null, name: p.data.name, month: p.data.month, amountVnd: p.data.amountVnd, note: p.data.note ?? null } });
  await logAudit({ actorId: req.user!.id, targetId: r.id, action: "payroll.created" });
  res.status(201).json(r);
});

payrollRouter.patch("/:id/paid", async (req, res) => {
  const r = await prisma.payroll.findUnique({ where: { id: req.params.id } });
  if (!r) return res.status(404).json({ error: "NOT_FOUND" });
  const updated = await prisma.payroll.update({ where: { id: r.id }, data: { paid: !r.paid, paidAt: r.paid ? null : new Date() } });
  res.json(updated);
});

payrollRouter.delete("/:id", async (req, res) => {
  await prisma.payroll.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "payroll.deleted" });
  res.json({ ok: true });
});
