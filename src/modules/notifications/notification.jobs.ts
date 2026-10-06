import { prisma } from "../../infrastructure/prisma.js";
import { registerJob } from "../../jobs/queues.js";
import { inAppNotifications, type NotificationInput, type NotificationRecipients, type NotificationService } from "./notification.service.js";

// Payload job 'notification.send'. Người nhận khai báo dạng "ý định", resolve lúc chạy job (đọc DB trong worker,
// lỗi thì BullMQ retry) để subscriber chỉ việc enqueue.
export type RecipientSpec = NotificationRecipients & {
  permission?: string; // mọi role có permission này (+ super_admin)
  orderSaleOf?: string; // sale phụ trách đơn (orderId)
};
export type NotificationJob = Omit<NotificationInput, "recipients"> & { recipients: RecipientSpec };

export async function resolveRecipients(spec: RecipientSpec, actorId?: string | null) {
  const roles = new Set(spec.roles ?? []);
  const userIds = new Set(spec.userIds ?? []);
  const vars: Record<string, string> = {};
  if (spec.permission) {
    const rs = await prisma.role.findMany({ where: { permissions: { some: { permission: { key: spec.permission } } } }, select: { key: true } });
    for (const r of rs) roles.add(r.key);
    roles.add("super_admin");
  }
  if (spec.orderSaleOf) {
    const o = await prisma.order.findUnique({ where: { id: spec.orderSaleOf }, select: { saleId: true, code: true } });
    if (o?.saleId) userIds.add(o.saleId);
    if (o?.code) vars.orderCode = o.code;
  }
  // Không báo cho chính người gây ra thay đổi (gửi theo user). Theo role thì lọc lúc đọc.
  if (actorId) userIds.delete(actorId);
  return { recipients: { roles: [...roles], userIds: [...userIds] }, vars };
}

const fill = (s: string | undefined, vars: Record<string, string>) => s?.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

export async function handleNotificationJob(job: NotificationJob, service: NotificationService = inAppNotifications) {
  const { recipients, vars } = await resolveRecipients(job.recipients, job.actorId);
  if (!recipients.roles.length && !recipients.userIds.length) return { sent: 0 };
  await service.notify({ ...job, recipients, title: fill(job.title, vars)!, body: fill(job.body, vars) });
  return { sent: recipients.roles.length + recipients.userIds.length };
}

registerJob("notification.send", (d: NotificationJob) => handleNotificationJob(d));
