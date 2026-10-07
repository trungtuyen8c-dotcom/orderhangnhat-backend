import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { paged, readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as admin from "./admin.service.js";
import { adminReset as resetTwoFactor } from "../auth/twoFactor.service.js";

export const adminRouter = Router();
adminRouter.use(authenticateEither);

const actor = (req: Request): admin.Actor => ({ id: req.user!.id, requestId: req.requestId });

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  fullName: z.string().optional(),
  roleKeys: z.array(z.string()).default([]),
});
const userUpdateSchema = z.object({ fullName: z.string().optional(), isActive: z.boolean().optional() });
const assignSchema = z.object({ roleKeys: z.array(z.string()) });
const roleSchema = z.object({
  key: z.string().min(2).regex(/^[a-z0-9_]+$/, "snake_case"),
  name: z.string().min(1),
  permissionKeys: z.array(z.string()).default([]),
});
const roleUpdateSchema = z.object({ name: z.string().min(1).optional(), permissionKeys: z.array(z.string()).optional() });
const auditQuerySchema = z.object({
  actor: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

adminRouter.get("/users", authorize("users.list"), asyncHandler(async (_req, res) => {
  res.json(await admin.listUsers());
}));

adminRouter.post("/users", authorize("users.create"), asyncHandler(async (req, res) => {
  const body = parseOr400(createUserSchema, req.body);
  res.status(201).json(await admin.createUser(body, actor(req)));
}));

adminRouter.patch("/users/:id", authorize("users.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(userUpdateSchema, req.body);
  res.json(await admin.updateUser(req.params.id, body, actor(req)));
}));

adminRouter.delete("/users/:id", authorize("users.delete"), asyncHandler(async (req, res) => {
  await admin.deleteUser(req.params.id, actor(req));
  res.json({ ok: true });
}));

// Reset 2FA (user mất điện thoại + mã khôi phục): xoá secret + mã khôi phục, user đăng nhập lại chỉ bằng mật khẩu.
adminRouter.post("/users/:id/2fa/reset", authorize("users.update"), asyncHandler(async (req, res) => {
  await resetTwoFactor(req.params.id, { id: req.user!.id, roles: req.user!.roles, requestId: req.requestId });
  res.json({ ok: true });
}));

adminRouter.post("/users/:id/roles", authorize("roles.assign"), asyncHandler(async (req, res) => {
  const { roleKeys } = parseOr400(assignSchema, req.body);
  await admin.assignRoles(req.params.id, roleKeys, actor(req));
  res.json({ ok: true });
}));

adminRouter.get("/roles", authorize("users.list"), asyncHandler(async (_req, res) => {
  res.json(await admin.listRoles());
}));

adminRouter.get("/permissions", authorize("permissions.list"), asyncHandler(async (_req, res) => {
  res.json(await admin.listPermissions());
}));

adminRouter.post("/roles", authorize("roles.create"), asyncHandler(async (req, res) => {
  const body = parseOr400(roleSchema, req.body);
  res.status(201).json(await admin.createRole(body, actor(req)));
}));

adminRouter.patch("/roles/:key", authorize("roles.update"), asyncHandler(async (req, res) => {
  const role = await admin.findEditableRole(req.params.key);
  const body = parseOr400(roleUpdateSchema, req.body);
  await admin.updateRole(role, body, actor(req));
  res.json({ ok: true });
}));

adminRouter.delete("/roles/:key", authorize("roles.delete"), asyncHandler(async (req, res) => {
  await admin.deleteRole(req.params.key, actor(req));
  res.json({ ok: true });
}));

// Mặc định trả mảng (frontend gọi ?limit=100). Lọc: actor (uuid), action (tiền tố), from/to (ISO date).
// Phân trang opt-in khi có ?page= -> { items, pagination }.
adminRouter.get("/audit", authorize("system.view_audit_log"), asyncHandler(async (req, res) => {
  const filter = parseOr400(auditQuerySchema, req.query);
  const limit = Math.min(Number(req.query.limit ?? 100), 300);
  const page = readPage(req, 50, 300);
  const { rows, total } = await admin.listAudit(filter, limit, page);
  res.json(page ? paged(rows, total ?? 0, page) : rows);
}));
