// Report users_list/roles_list/permissions_list/audit_log - đọc qua admin.service.
import { prisma } from "../../../infrastructure/prisma.js";
import { listPermissions, listRoles, listUsers } from "../../admin/admin.service.js";

export const users_list = () => listUsers();
export const roles_list = () => listRoles();
export const permissions_list = () => listPermissions();

// Không dùng admin.service.listAudit: bản đó trả cả ipAddress - không lộ IP actor ra kênh AI-facing.
export async function audit_log(params: { limit?: number }) {
  const take = Math.min(params.limit ?? 100, 300);
  const rows = await prisma.accessAudit.findMany({
    orderBy: { createdAt: "desc" }, take,
    select: { id: true, actorId: true, targetId: true, action: true, metadata: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, id: r.id.toString() }));
}
