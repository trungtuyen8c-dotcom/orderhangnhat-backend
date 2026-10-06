import { eventBus } from "../../app/events/EventBus.js";
import type { BusinessEvent, BusinessEventName } from "../../app/events/businessEvents.js";
import { enqueue } from "../../jobs/queues.js";
import type { NotificationJob } from "./notification.jobs.js";

// Import 1 lần từ src/index.ts. Handler chỉ map event -> payload job 'notification.send' (không gọi DB/kênh gửi).
// Ai nhận do notification.jobs resolve.
const RECONCILE = "accounting.reconcile";
const fmt = (n: unknown) => Number(n ?? 0).toLocaleString("vi-VN");

type Builder = (e: BusinessEvent) => Omit<NotificationJob, "id" | "type" | "actorId" | "entityType" | "entityId">;

export const notificationRules: Partial<Record<BusinessEventName, Builder>> = {
  "deposit.created": (e) => ({
    recipients: { permission: RECONCILE },
    title: "Cọc mới cần xác nhận",
    body: `${fmt(e.metadata?.amountVnd)} VND`,
  }),
  "fund.created": (e) => ({
    recipients: { permission: RECONCILE },
    title: "Giao dịch quỹ mới cần xác nhận",
    body: `${String(e.metadata?.type ?? "")} ${fmt(e.metadata?.amountYen)} JPY`.trim(),
  }),
  "order.status_changed": (e) => ({
    recipients: { orderSaleOf: e.entityId },
    title: "Đơn {orderCode} đổi trạng thái",
    body: `${String(e.metadata?.from ?? "?")} -> ${String(e.metadata?.to ?? "?")}`,
  }),
  "carton.locked": () => ({
    recipients: { permission: "trackings.update" },
    title: "Kiện bị khóa cân, cần kiểm tra",
  }),
};

export function toNotificationJob(e: BusinessEvent): NotificationJob | null {
  const build = notificationRules[e.eventName];
  if (!build) return null;
  return { ...build(e), id: e.eventId, type: e.eventName, actorId: e.actorId, entityType: e.entityType, entityId: e.entityId };
}

export function registerNotificationSubscribers() {
  for (const name of Object.keys(notificationRules) as BusinessEventName[]) {
    eventBus.on(name, async (e) => {
      const job = toNotificationJob(e);
      if (job) await enqueue("notification.send", job as unknown as Record<string, unknown>);
    });
  }
}

registerNotificationSubscribers();
