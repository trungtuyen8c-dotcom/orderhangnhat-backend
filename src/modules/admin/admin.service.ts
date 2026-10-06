import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import type { PageParams } from "../../app/http/pagination.js";
import { invalidatePermissions } from "../../middlewares/authorize.js";
import { hashPassword } from "../auth/password.js";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; requestId?: string };

const notFound = () => new AppError("NOT_FOUND", 404);

// ---- Users ----

export async function listUsers() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, fullName: true, isActive: true, roles: { select: { role: { select: { key: true, name: true } } } } },
  });
  return users.map((u) => ({ ...u, roles: u.roles.map((r) => r.role.key) }));
}

async function grantRoles(tx: Tx, userId: string, roleKeys: string[], grantedBy: string) {
  const roles = await tx.role.findMany({ where: { key: { in: roleKeys } }, select: { id: true } });
  if (roles.length) await tx.userRole.createMany({ data: roles.map((r) => ({ userId, roleId: r.id, grantedBy })) });
}

export async function createUser(
  input: { email: string; password: string; fullName?: string; roleKeys: string[] },
  actor: Actor,
) {
  if (await prisma.user.findUnique({ where: { email: input.email } })) throw new AppError("EMAIL_EXISTS", 409);
  const passwordHash = await hashPassword(input.password);
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({ data: { id: uuid(), email: input.email, passwordHash, fullName: input.fullName } });
    await grantRoles(tx, u.id, input.roleKeys, actor.id);
    return u;
  });
  await logAudit({ actorId: actor.id, targetId: user.id, action: "user.created", metadata: { roles: input.roleKeys }, requestId: actor.requestId, entity: "user" });
  return { id: user.id, email: user.email };
}

export async function updateUser(id: string, data: { fullName?: string; isActive?: boolean }, actor: Actor) {
  const user = await prisma.user.update({ where: { id }, data });
  if (data.isActive === false) await invalidatePermissions(user.id);
  await logAudit({ actorId: actor.id, targetId: user.id, action: "user.updated", metadata: data, requestId: actor.requestId, entity: "user" });
  return { id: user.id };
}

export async function deleteUser(id: string, actor: Actor) {
  if (id === actor.id) throw new AppError("CANNOT_DELETE_SELF", 400);
  const target = await prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
  if (!target) throw notFound();
  if (target.roles.some((r) => r.role.key === "super_admin")) throw new AppError("PROTECTED", 403, "Không xóa được super admin");
  await prisma.user.delete({ where: { id: target.id } });
  await logAudit({ actorId: actor.id, targetId: target.id, action: "user.deleted", requestId: actor.requestId, entity: "user" });
}

export async function assignRoles(userId: string, roleKeys: string[], actor: Actor) {
  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw notFound();
  await prisma.$transaction(async (tx) => {
    await tx.userRole.deleteMany({ where: { userId: target.id } });
    await grantRoles(tx, target.id, roleKeys, actor.id);
  });
  await invalidatePermissions(target.id);
  await logAudit({ actorId: actor.id, targetId: target.id, action: "role.assigned", metadata: { roles: roleKeys }, requestId: actor.requestId, entity: "user" });
}

// ---- Roles / permissions ----

export async function listRoles() {
  const roles = await prisma.role.findMany({
    orderBy: { id: "asc" },
    select: { id: true, key: true, name: true, isSystem: true, permissions: { select: { permission: { select: { key: true } } } } },
  });
  return roles.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.key) }));
}

export function listPermissions() {
  return prisma.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }], select: { key: true, resource: true, action: true } });
}

async function setRolePermissions(tx: Tx, roleId: number, keys: string[]) {
  const perms = await tx.permission.findMany({ where: { key: { in: keys } }, select: { id: true } });
  await tx.rolePermission.deleteMany({ where: { roleId } });
  if (perms.length) await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId, permissionId: p.id })) });
}

export async function createRole(input: { key: string; name: string; permissionKeys: string[] }, actor: Actor) {
  if (await prisma.role.findUnique({ where: { key: input.key } })) throw new AppError("ROLE_EXISTS", 409);
  const role = await prisma.$transaction(async (tx) => {
    const r = await tx.role.create({ data: { key: input.key, name: input.name, isSystem: false } });
    await setRolePermissions(tx, r.id, input.permissionKeys);
    return r;
  });
  await logAudit({ actorId: actor.id, action: "role.created", metadata: { key: input.key }, requestId: actor.requestId, entity: "role" });
  return role;
}

// Kiểm tra tồn tại/được bảo vệ TRƯỚC khi validate body - giữ thứ tự lỗi cũ (404/403 trước 400).
export async function findEditableRole(key: string) {
  const role = await prisma.role.findUnique({ where: { key } });
  if (!role) throw notFound();
  if (role.key === "super_admin") throw new AppError("PROTECTED", 403, "Không sửa được super_admin");
  return role;
}

export async function updateRole(role: { id: number; key: string }, input: { name?: string; permissionKeys?: string[] }, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    if (input.name) await tx.role.update({ where: { id: role.id }, data: { name: input.name } });
    if (input.permissionKeys) await setRolePermissions(tx, role.id, input.permissionKeys);
  });
  // Cache quyền của mọi user mang role này phải bỏ sau khi commit
  const urs = await prisma.userRole.findMany({ where: { roleId: role.id }, select: { userId: true } });
  await Promise.all(urs.map((ur) => invalidatePermissions(ur.userId)));
  await logAudit({ actorId: actor.id, action: "role.updated", metadata: { key: role.key }, requestId: actor.requestId, entity: "role", after: input });
}

export async function deleteRole(key: string, actor: Actor) {
  const role = await prisma.role.findUnique({ where: { key } });
  if (!role) throw notFound();
  if (role.isSystem) throw new AppError("PROTECTED", 403, "Không xóa được vai trò hệ thống");
  await prisma.role.delete({ where: { id: role.id } });
  await logAudit({ actorId: actor.id, action: "role.deleted", metadata: { key: role.key }, requestId: actor.requestId, entity: "role" });
}

// ---- Audit log ----

export type AuditFilter = { actor?: string; action?: string; from?: Date; to?: Date };

export function buildAuditWhere(f: AuditFilter): Prisma.AccessAuditWhereInput {
  return {
    ...(f.actor ? { actorId: f.actor } : {}),
    ...(f.action ? { action: { startsWith: f.action } } : {}),
    ...(f.from || f.to ? { createdAt: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
  };
}

const serializeAudit = <T extends { id: bigint }>(r: T) => ({ ...r, id: r.id.toString() });

// Không có page -> mảng (giữ contract cũ, take = limit tối đa 300). Có page -> { items, pagination }.
export async function listAudit(f: AuditFilter, limit: number, page: PageParams | null) {
  const where = buildAuditWhere(f);
  if (!page) {
    const rows = await prisma.accessAudit.findMany({ where, orderBy: { createdAt: "desc" }, take: limit });
    return { rows: rows.map(serializeAudit) };
  }
  const [rows, total] = await prisma.$transaction([
    prisma.accessAudit.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.take }),
    prisma.accessAudit.count({ where }),
  ]);
  return { rows: rows.map(serializeAudit), total };
}
