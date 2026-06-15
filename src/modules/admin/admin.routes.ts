import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { invalidatePermissions } from "../../middlewares/authorize.js";
import { hashPassword } from "../../utils/password.js";
import { logAudit } from "../../utils/audit.js";

export const adminRouter = Router();
adminRouter.use(authenticate);

adminRouter.get("/users", authorize("users.list"), async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, fullName: true, isActive: true, roles: { select: { role: { select: { key: true, name: true } } } } },
  });
  res.json(users.map((u) => ({ ...u, roles: u.roles.map((r) => r.role.key) })));
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().optional(),
  roleKeys: z.array(z.string()).default([]),
});

adminRouter.post("/users", authorize("users.create"), async (req, res) => {
  const p = createUserSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const exists = await prisma.user.findUnique({ where: { email: p.data.email } });
  if (exists) return res.status(409).json({ error: "EMAIL_EXISTS" });

  const user = await prisma.user.create({
    data: { id: uuid(), email: p.data.email, passwordHash: await hashPassword(p.data.password), fullName: p.data.fullName },
  });
  const roles = await prisma.role.findMany({ where: { key: { in: p.data.roleKeys } } });
  for (const r of roles) await prisma.userRole.create({ data: { userId: user.id, roleId: r.id, grantedBy: req.user!.id } });
  await logAudit({ actorId: req.user!.id, targetId: user.id, action: "user.created", metadata: { roles: p.data.roleKeys } });
  res.status(201).json({ id: user.id, email: user.email });
});

adminRouter.get("/roles", authorize("users.list"), async (_req, res) => {
  const roles = await prisma.role.findMany({ orderBy: { id: "asc" }, select: { key: true, name: true } });
  res.json(roles);
});

const assignSchema = z.object({ roleKeys: z.array(z.string()) });
adminRouter.post("/users/:id/roles", authorize("roles.assign"), async (req, res) => {
  const p = assignSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "NOT_FOUND" });

  const roles = await prisma.role.findMany({ where: { key: { in: p.data.roleKeys } } });
  await prisma.userRole.deleteMany({ where: { userId: target.id } });
  for (const r of roles) await prisma.userRole.create({ data: { userId: target.id, roleId: r.id, grantedBy: req.user!.id } });
  await invalidatePermissions(target.id);
  await logAudit({ actorId: req.user!.id, targetId: target.id, action: "role.assigned", metadata: { roles: p.data.roleKeys } });
  res.json({ ok: true });
});

adminRouter.get("/audit", authorize("system.view_audit_log"), async (req, res) => {
  const take = Math.min(Number(req.query.limit ?? 100), 300);
  const rows = await prisma.accessAudit.findMany({ orderBy: { createdAt: "desc" }, take });
  res.json(rows.map((r) => ({ ...r, id: r.id.toString() })));
});
