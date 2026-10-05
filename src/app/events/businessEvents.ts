export const BusinessEvents = [
  "order.created",
  "order.updated",
  "order.deleted",
  "order.status_changed",
  "payment.created",
  "payment.refunded",
  "deposit.created",
  "deposit.confirmed",
  "deposit.deleted",
  "fund.created",
  "fund.confirmed",
  "wallet.transaction_created",
  "wallet.transfer_completed",
  "customer.updated",
  "tracking.assigned",
  "tracking.updated",
  "carton.created",
  "carton.locked",
  "warehouse.weight_confirmed",
] as const;

export type BusinessEventName = (typeof BusinessEvents)[number];

// Không đưa secret/token/password vào metadata.
export type BusinessEvent = {
  eventId: string;
  eventName: BusinessEventName;
  occurredAt: string;
  actorId: string | null;
  entityType: string;
  entityId: string;
  metadata?: Record<string, unknown>;
};
