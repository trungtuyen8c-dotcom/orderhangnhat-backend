import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../jobs/queues.js", () => ({ registerJob: vi.fn() }));
vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { role: { findMany: vi.fn() }, order: { findUnique: vi.fn() } },
}));

import { handleNotificationJob, resolveRecipients } from "./notification.jobs.js";
import { registerJob } from "../../jobs/queues.js";
import { prisma } from "../../infrastructure/prisma.js";

const mp = prisma as any;
const registered = (registerJob as any).mock.calls.map((c: any[]) => c[0]);

describe("notification.send job", () => {
  beforeEach(() => { mp.role.findMany.mockReset(); mp.order.findUnique.mockReset(); });

  it("module_import_registersNotificationSendHandler", () => {
    expect(registered).toContain("notification.send");
  });

  it("resolveRecipients_permission_returnsRolesHavingItPlusSuperAdmin", async () => {
    mp.role.findMany.mockResolvedValue([{ key: "accountant" }]);
    const r = await resolveRecipients({ permission: "accounting.reconcile" });
    expect(mp.role.findMany.mock.calls[0][0].where).toEqual({ permissions: { some: { permission: { key: "accounting.reconcile" } } } });
    expect(r.recipients.roles.sort()).toEqual(["accountant", "super_admin"]);
  });

  it("resolveRecipients_orderSale_returnsSaleAndOrderCode", async () => {
    mp.order.findUnique.mockResolvedValue({ saleId: "s1", code: "DH001" });
    const r = await resolveRecipients({ orderSaleOf: "o1" }, "u-other");
    expect(r.recipients.userIds).toEqual(["s1"]);
    expect(r.vars).toEqual({ orderCode: "DH001" });
  });

  it("resolveRecipients_saleIsActor_excludesSelf", async () => {
    mp.order.findUnique.mockResolvedValue({ saleId: "s1", code: "DH001" });
    expect((await resolveRecipients({ orderSaleOf: "o1" }, "s1")).recipients.userIds).toEqual([]);
  });

  it("handleNotificationJob_orderWithSale_notifiesWithFilledTitle", async () => {
    // Given
    mp.order.findUnique.mockResolvedValue({ saleId: "s1", code: "DH001" });
    const service = { notify: vi.fn() };
    // When
    const r = await handleNotificationJob({ id: "ev1", type: "order.status_changed", title: "Đơn {orderCode} đổi trạng thái", body: "a -> b", actorId: "u1", recipients: { orderSaleOf: "o1" } }, service);
    // Then
    expect(r).toEqual({ sent: 1 });
    expect(service.notify).toHaveBeenCalledWith(expect.objectContaining({ id: "ev1", title: "Đơn DH001 đổi trạng thái", recipients: { roles: [], userIds: ["s1"] } }));
  });

  it("handleNotificationJob_orderWithoutSale_skipsNotify", async () => {
    mp.order.findUnique.mockResolvedValue({ saleId: null, code: "DH002" });
    const service = { notify: vi.fn() };
    expect(await handleNotificationJob({ type: "order.status_changed", title: "x", recipients: { orderSaleOf: "o2" } }, service)).toEqual({ sent: 0 });
    expect(service.notify).not.toHaveBeenCalled();
  });
});
