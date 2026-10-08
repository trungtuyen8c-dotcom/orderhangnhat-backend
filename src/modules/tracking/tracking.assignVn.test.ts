import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  tracking: { findMany: vi.fn(), updateMany: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock("../../infrastructure/prisma.js", () => ({ prisma: db }));
vi.mock("../orders/order.state.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn(), queueTrackingSheetRow: vi.fn(), queueTrackingSheetRowRemoval: vi.fn() }));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../cartons/carton.service.js", () => ({ deleteCartonIfEmpty: vi.fn() }));
vi.mock("../sheets/orphanTracking.js", () => ({ createOrphanTrackingSafe: vi.fn() }));
vi.mock("../invoices/invoice.repository.js", () => ({ createInvoiceHistory: vi.fn() }));

import { assignVnTracking } from "./tracking.service.js";
import { bumpOrderStatus } from "../orders/order.state.js";

const actor = { id: "u1", roles: ["admin"] } as never;

beforeEach(() => {
  vi.clearAllMocks();
  db.$transaction.mockImplementation(async (fn: (tx: typeof db) => unknown) => fn(db));
});

// firstTime: tracking chưa có mã VN; rows: mọi tracking được gán (kèm đơn)
function seed(firstTime: string[], rows: { id: string; orderId: string | null }[]) {
  db.tracking.findMany
    .mockResolvedValueOnce(firstTime.map((id) => ({ id })))
    .mockResolvedValueOnce(rows.map((r) => ({ ...r, order: r.orderId ? { customerId: "c1" } : null })));
}

describe("assignVnTracking", () => {
  it("assignVnTracking_firstVnCode_setsDeliveredAtAndBumpsOrderToDelivered", async () => {
    seed(["t1"], [{ id: "t1", orderId: "o1" }]);
    await assignVnTracking(["t1"], " VN123 ", actor);
    expect(db.tracking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { deliveredAt: expect.any(Date) } });
    expect(bumpOrderStatus).toHaveBeenCalledWith("o1", "delivered", db);
  });

  it("assignVnTracking_alreadyHadVnCode_doesNotResetDeliveredOrBump", async () => {
    seed([], [{ id: "t1", orderId: "o1" }]);
    await assignVnTracking(["t1"], "VN999", actor);
    expect(db.tracking.updateMany).toHaveBeenCalledTimes(1);
    expect(bumpOrderStatus).not.toHaveBeenCalled();
  });

  it("assignVnTracking_twoTrackingsSameOrder_bumpsOrderOnce", async () => {
    seed(["t1", "t2"], [{ id: "t1", orderId: "o1" }, { id: "t2", orderId: "o1" }]);
    await assignVnTracking(["t1", "t2"], "VN1", actor);
    expect(bumpOrderStatus).toHaveBeenCalledTimes(1);
  });

  it("assignVnTracking_orphanTracking_noOrderBump", async () => {
    seed(["t1"], [{ id: "t1", orderId: null }]);
    await assignVnTracking(["t1"], "VN1", actor);
    expect(bumpOrderStatus).not.toHaveBeenCalled();
  });

  it("assignVnTracking_any_storesTrimmedCodeAndVnReceived", async () => {
    seed([], [{ id: "t1", orderId: null }]);
    await assignVnTracking(["t1"], "  VN7  ", actor);
    expect(db.tracking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { vnTrackingCode: "VN7", status: "vn_received" } });
  });
});
