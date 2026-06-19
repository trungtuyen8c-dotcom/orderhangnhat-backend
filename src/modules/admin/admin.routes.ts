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
  const roles = await prisma.role.findMany({
    orderBy: { id: "asc" },
    select: { id: true, key: true, name: true, isSystem: true, permissions: { select: { permission: { select: { key: true } } } } },
  });
  res.json(roles.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.key) })));
});

adminRouter.get("/permissions", authorize("permissions.list"), async (_req, res) => {
  const perms = await prisma.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }], select: { key: true, resource: true, action: true } });
  res.json(perms);
});

async function setRolePermissions(roleId: number, keys: string[]) {
  const perms = await prisma.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
  await prisma.rolePermission.deleteMany({ where: { roleId } });
  for (const p of perms) await prisma.rolePermission.create({ data: { roleId, permissionId: p.id } });
}

const roleSchema = z.object({
  key: z.string().min(2).regex(/^[a-z0-9_]+$/, "snake_case"),
  name: z.string().min(1),
  permissionKeys: z.array(z.string()).default([]),
});

adminRouter.post("/roles", authorize("roles.create"), async (req, res) => {
  const p = roleSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (await prisma.role.findUnique({ where: { key: p.data.key } })) return res.status(409).json({ error: "ROLE_EXISTS" });
  const role = await prisma.role.create({ data: { key: p.data.key, name: p.data.name, isSystem: false } });
  await setRolePermissions(role.id, p.data.permissionKeys);
  await logAudit({ actorId: req.user!.id, action: "role.created", metadata: { key: p.data.key } });
  res.status(201).json(role);
});

const roleUpdateSchema = z.object({ name: z.string().min(1).optional(), permissionKeys: z.array(z.string()).optional() });

adminRouter.patch("/roles/:key", authorize("roles.update"), async (req, res) => {
  const role = await prisma.role.findUnique({ where: { key: req.params.key } });
  if (!role) return res.status(404).json({ error: "NOT_FOUND" });
  if (role.key === "super_admin") return res.status(403).json({ error: "PROTECTED", message: "Không sửa được super_admin" });
  const p = roleUpdateSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (p.data.name) await prisma.role.update({ where: { id: role.id }, data: { name: p.data.name } });
  if (p.data.permissionKeys) await setRolePermissions(role.id, p.data.permissionKeys);

  // Invalidate cache của mọi user mang role này
  const urs = await prisma.userRole.findMany({ where: { roleId: role.id }, select: { userId: true } });
  for (const ur of urs) await invalidatePermissions(ur.userId);
  await logAudit({ actorId: req.user!.id, action: "role.updated", metadata: { key: role.key } });
  res.json({ ok: true });
});

adminRouter.delete("/roles/:key", authorize("roles.delete"), async (req, res) => {
  const role = await prisma.role.findUnique({ where: { key: req.params.key } });
  if (!role) return res.status(404).json({ error: "NOT_FOUND" });
  if (role.isSystem) return res.status(403).json({ error: "PROTECTED", message: "Không xóa được vai trò hệ thống" });
  await prisma.role.delete({ where: { id: role.id } });
  await logAudit({ actorId: req.user!.id, action: "role.deleted", metadata: { key: role.key } });
  res.json({ ok: true });
});

const userUpdateSchema = z.object({ fullName: z.string().optional(), isActive: z.boolean().optional() });

adminRouter.patch("/users/:id", authorize("users.update"), async (req, res) => {
  const p = userUpdateSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const user = await prisma.user.update({ where: { id: req.params.id }, data: p.data });
  if (p.data.isActive === false) await invalidatePermissions(user.id);
  await logAudit({ actorId: req.user!.id, targetId: user.id, action: "user.updated", metadata: p.data });
  res.json({ id: user.id });
});

adminRouter.delete("/users/:id", authorize("users.delete"), async (req, res) => {
  if (req.params.id === req.user!.id) return res.status(400).json({ error: "CANNOT_DELETE_SELF" });
  const target = await prisma.user.findUnique({ where: { id: req.params.id }, include: { roles: { include: { role: true } } } });
  if (!target) return res.status(404).json({ error: "NOT_FOUND" });
  if (target.roles.some((r) => r.role.key === "super_admin")) return res.status(403).json({ error: "PROTECTED", message: "Không xóa được super admin" });
  await prisma.user.delete({ where: { id: target.id } });
  await logAudit({ actorId: req.user!.id, targetId: target.id, action: "user.deleted" });
  res.json({ ok: true });
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
