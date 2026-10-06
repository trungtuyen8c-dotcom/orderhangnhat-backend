import { randomUUID } from "crypto";
import type { BusinessEvent, BusinessEventName } from "./businessEvents.js";
import { logError } from "../../infrastructure/systemLog.js";

type Handler = (e: BusinessEvent) => void | Promise<void>;

// In-process bus. Chỉ publish SAU khi DB transaction commit.
// Handler phải nhanh: việc chậm/cần retry thì handler đẩy job vào queue (src/jobs/queues.ts).
class EventBus {
  private handlers = new Map<BusinessEventName, Handler[]>();

  on(name: BusinessEventName, h: Handler) {
    this.handlers.set(name, [...(this.handlers.get(name) ?? []), h]);
  }

  publish(input: Omit<BusinessEvent, "eventId" | "occurredAt">): void {
    const e: BusinessEvent = { ...input, eventId: randomUUID(), occurredAt: new Date().toISOString() };
    for (const h of this.handlers.get(e.eventName) ?? []) {
      Promise.resolve()
        .then(() => h(e))
        .catch((err) => logError({ event: e.eventName, entity_id: e.entityId, err: (err as Error).message }, "event_handler_failed"));
    }
  }

  reset() {
    this.handlers.clear();
  }
}

export const eventBus = new EventBus();
