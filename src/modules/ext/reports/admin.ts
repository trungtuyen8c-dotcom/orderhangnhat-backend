// Report users_list/roles_list/permissions_list/audit_log - copy logic từ admin.routes.ts.
import { prisma } from "../../../infrastructure/prisma.js";

export async function users_list() {
  const rows = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true, email: true, fullName: true, isActive: true, roles: { select: { role: { select: { key: true, name: true } } } } },
  });
  return rows.map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, isActive: u.isActive, roles: u.roles.map((r) => r.role.key) }));
}

export async function roles_list() {
  const rows = await prisma.role.findMany({
    orderBy: { id: "asc" },
    select: { id: true, key: true, name: true, isSystem: true, permissions: { select: { permission: { select: { key: true } } } } },
  });
  return rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, permissions: r.permissions.map((p) => p.permission.key) }));
}

export function permissions_list() {
  return prisma.permission.findMany({ orderBy: [{ resource: "asc" }, { action: "asc" }], select: { key: true, resource: true, action: true } });
}

export async function audit_log(params: { limit?: number }) {
  const take = Math.min(params.limit ?? 100, 300);
  const rows = await prisma.accessAudit.findMany({
    orderBy: { createdAt: "desc" }, take,
    select: { id: true, actorId: true, targetId: true, action: true, metadata: true, createdAt: true },
  });
  // Bỏ ipAddress khỏi response AI-facing (agent lưu ý IP nội bộ/thật của actor không nên lộ ra ngoài).
  return rows.map((r) => ({ ...r, id: r.id.toString() }));
}
