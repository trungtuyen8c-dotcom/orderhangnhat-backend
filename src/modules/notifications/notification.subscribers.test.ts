import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../jobs/queues.js", () => ({ enqueue: vi.fn(), registerJob: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { eventBus } from "../../app/events/EventBus.js";
import { enqueue } from "../../jobs/queues.js";
import { toNotificationJob } from "./notification.subscribers.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const mockEnqueue = enqueue as unknown as ReturnType<typeof vi.fn>;

describe("notification subscribers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("depositCreated_published_enqueuesNotificationForReconcilePermission", async () => {
    // Given: subscribers đã đăng ký lúc import
    // When
    eventBus.publish({ eventName: "deposit.created", actorId: "u-sale", entityType: "customer_deposit", entityId: "d1", metadata: { customerId: "c1", amountVnd: 1500000 } });
    await flush();
    // Then
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    const [name, job] = mockEnqueue.mock.calls[0];
    expect(name).toBe("notification.send");
    expect(job).toMatchObject({
      type: "deposit.created", recipients: { permission: "accounting.reconcile" }, actorId: "u-sale",
      entityType: "customer_deposit", entityId: "d1", title: "Cọc mới cần xác nhận",
    });
    expect(job.body).toContain("VND");
    expect(typeof job.id).toBe("string");
  });

  it("fundCreated_published_enqueuesNotificationForReconcilePermission", async () => {
    eventBus.publish({ eventName: "fund.created", actorId: "u1", entityType: "fund_txn", entityId: "f1", metadata: { type: "in", amountYen: 20000 } });
    await flush();
    expect(mockEnqueue).toHaveBeenCalledWith("notification.send", expect.objectContaining({ type: "fund.created", recipients: { permission: "accounting.reconcile" }, entityId: "f1" }));
  });

  it("orderStatusChanged_published_enqueuesNotificationForOrderSale", async () => {
    eventBus.publish({ eventName: "order.status_changed", actorId: "u1", entityType: "order", entityId: "o1", metadata: { from: "new", to: "paid" } });
    await flush();
    expect(mockEnqueue).toHaveBeenCalledWith("notification.send", expect.objectContaining({
      type: "order.status_changed", recipients: { orderSaleOf: "o1" }, title: "Đơn {orderCode} đổi trạng thái", body: "new -> paid",
    }));
  });

  it("eventWithoutRule_published_enqueuesNothing", async () => {
    eventBus.publish({ eventName: "customer.updated", actorId: "u1", entityType: "customer", entityId: "c1" });
    await flush();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("toNotificationJob_usesEventIdAsNotificationId_forIdempotentRetries", () => {
    const job = toNotificationJob({ eventId: "ev-1", eventName: "carton.locked", occurredAt: "", actorId: null, entityType: "carton", entityId: "k1" });
    expect(job).toMatchObject({ id: "ev-1", type: "carton.locked", recipients: { permission: "trackings.update" }, entityId: "k1" });
  });
});
