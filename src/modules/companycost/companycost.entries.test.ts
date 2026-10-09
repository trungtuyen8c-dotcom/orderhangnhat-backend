import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    tracking: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
    order: { findUnique: vi.fn() },
    packDayLock: { findUnique: vi.fn() },
    companyCost: { create: vi.fn(), findUnique: vi.fn(), delete: vi.fn(), update: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../accounting/accounting.repository.js", () => ({ lockOrder: vi.fn(), writeAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));

import { createEntry, deleteEntry, togglePaid } from "./companycost.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { lockOrder, writeAudit } from "../accounting/accounting.repository.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { AppError } from "../../app/errors/AppError.js";

const mp = prisma as any;
const actor = { id: "u1" };
const base = { kind: "chakubarai" as const, month: "2026-03", amount: 50000, currency: "VND" as const };

const order: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mp.companyCost.create.mockImplementation(async ({ data }: any) => { order.push("create"); return data; });
  mp.tracking.findUnique.mockImplementation(async ({ select }: any) => (select.orderId ? { orderId: "o1" } : { packedAt: null }));
  (lockOrder as any).mockImplementation(async () => { order.push("lock"); return { id: "o1", customerId: "c1" }; });
  (recomputeOrderTotals as any).mockImplementation(async () => { order.push("recompute"); });
  (writeAudit as any).mockImplementation(async () => { order.push("audit"); });
  (queueCustomerSheetSync as any).mockImplementation(async () => { order.push("queue"); });
  mp.$transaction.mockImplementation(async (fn: any) => { order.push("tx:start"); const r = await fn(mp); order.push("tx:commit"); return r; });
});

async function rejection(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AppError; }
  throw new Error("expected rejection");
}

describe("createEntry", () => {
  it("createEntry_chakubaraiByTracking_createsCostRecomputesDebtInSameTxThenQueuesSheetAfterCommit", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    const c = await createEntry({ ...base, trackingCode: " T1 " }, actor);
    expect(mp.tracking.findFirst).toHaveBeenCalledWith({ where: { code: "T1" }, select: { id: true } });
    expect(c).toMatchObject({ refId: "t1", amountVnd: 50000, lateAfterLock: false });
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1", mp);
    expect(order).toEqual(["tx:start", "create", "lock", "recompute", "audit", "tx:commit", "queue"]);
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("createEntry_unknownTrackingCode_createsOrphanTrackingAndLinksCostWithoutDebt", async () => {
    mp.tracking.findFirst.mockResolvedValue(null);
    mp.tracking.create.mockImplementation(async ({ data }: any) => data);
    mp.tracking.findUnique.mockImplementation(async ({ select }: any) => (select.orderId ? { orderId: null } : { packedAt: null }));
    const c = await createEntry({ ...base, trackingCode: " NEW1 " }, actor);
    expect(mp.tracking.create).toHaveBeenCalledWith({ data: { id: expect.any(String), code: "NEW1", status: "new" } });
    const orphanId = mp.tracking.create.mock.calls[0][0].data.id;
    expect(c).toMatchObject({ refId: orphanId, amountVnd: 50000 });
    expect(lockOrder).not.toHaveBeenCalled();
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("createEntry_trackingWithoutOrder_acceptedAndNotAppliedToCustomer", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1" });
    mp.tracking.findUnique.mockImplementation(async ({ select }: any) => (select.orderId ? { orderId: null } : { packedAt: null }));
    const c = await createEntry({ ...base, trackingCode: "T1" }, actor);
    expect(c).toMatchObject({ refId: "t1" });
    expect(mp.tracking.create).not.toHaveBeenCalled();
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("createEntry_orderCodeWithMultipleTrackings_throws400AskingForTrackingCode", async () => {
    mp.order.findUnique.mockResolvedValue({ trackings: [{ id: "a" }, { id: "b" }] });
    const e = await rejection(createEntry({ ...base, orderCode: "OD1" }, actor));
    expect(e.message).toBe("Đơn có nhiều tracking - nhập đúng mã tracking để xác định");
  });

  it("createEntry_orderCodeWithSingleTracking_usesThatTracking", async () => {
    mp.order.findUnique.mockResolvedValue({ trackings: [{ id: "t9" }] });
    const c = await createEntry({ ...base, orderCode: "OD1" }, actor);
    expect(c).toMatchObject({ refId: "t9" });
  });

  it("createEntry_nonCodJpyWithoutRate_throws400", async () => {
    const e = await rejection(createEntry({ ...base, kind: "weight", currency: "JPY" }, actor));
    expect(e.toBody()).toEqual({ error: "BAD_REQUEST", message: "Nhập JPY cần tỉ giá" });
  });

  it.each(["chakubarai", "daibiki_topup"] as const)("createEntry_%s_jpyWithoutRate_acceptedWithZeroVnd", async (kind) => {
    const c = await createEntry({ ...base, kind, currency: "JPY", amount: 1200 }, actor);
    expect(c).toMatchObject({ kind, currency: "JPY", amountOrig: 1200, amountVnd: 0, exchangeRate: null });
  });

  it("createEntry_chakubaraiJpyWithRate_convertsVnd", async () => {
    const c = await createEntry({ ...base, currency: "JPY", amount: 1000, exchangeRate: 170 }, actor);
    expect(c).toMatchObject({ amountVnd: 170000, exchangeRate: 170 });
  });

  it("createEntry_paymentKind_savedUnlinkedWithoutTrackingLookup", async () => {
    const c = await createEntry({ ...base, kind: "payment", amount: 2000000, trackingCode: "T1" }, actor);
    expect(c).toMatchObject({ kind: "payment", amountVnd: 2000000, refId: null });
    expect(mp.tracking.findFirst).not.toHaveBeenCalled();
    expect(mp.tracking.create).not.toHaveBeenCalled();
  });

  it("createEntry_jpyWithRate_roundsVndAmount", async () => {
    const c = await createEntry({ ...base, kind: "other", currency: "JPY", amount: 1001, exchangeRate: 170.5 }, actor);
    expect(c).toMatchObject({ amountVnd: Math.round(1001 * 170.5), amountOrig: 1001, refId: null });
  });

  it("createEntry_nonChakubaraiKind_ignoresTrackingAndDoesNotTouchDebt", async () => {
    await createEntry({ ...base, kind: "weight", trackingCode: "T1" }, actor);
    expect(mp.tracking.findFirst).not.toHaveBeenCalled();
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("createEntry_trackingDayAlreadyLocked_marksLateAfterLock", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    mp.tracking.findUnique.mockImplementation(async ({ select }: any) => (select.orderId ? { orderId: "o1" } : { packedAt: new Date("2026-03-02T05:00:00Z") }));
    mp.packDayLock.findUnique.mockResolvedValue({ date: new Date() });
    const c = await createEntry({ ...base, trackingCode: "T1" }, actor);
    expect(c).toMatchObject({ lateAfterLock: true });
  });

  it("createEntry_recomputeFails_rollsBackAndDoesNotQueueSheet", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    (recomputeOrderTotals as any).mockRejectedValue(new Error("db"));
    await expect(createEntry({ ...base, trackingCode: "T1" }, actor)).rejects.toThrow("db");
    expect(order).not.toContain("tx:commit");
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });
});

describe("deleteEntry", () => {
  it("deleteEntry_missing_throws404NotFound", async () => {
    mp.companyCost.findUnique.mockResolvedValue(null);
    const e = await rejection(deleteEntry("x", actor));
    expect(e.status).toBe(404);
    expect(e.toBody()).toEqual({ error: "NOT_FOUND" });
  });

  it("deleteEntry_linkedToTracking_recomputesDebtInTxThenQueuesSheet", async () => {
    mp.companyCost.findUnique.mockResolvedValue({ id: "cc1", refId: "t1" });
    expect(await deleteEntry("cc1", actor)).toEqual({ ok: true });
    expect(order).toEqual(["tx:start", "lock", "recompute", "audit", "tx:commit", "queue"]);
    expect(mp.companyCost.delete).toHaveBeenCalledWith({ where: { id: "cc1" } });
  });

  it("deleteEntry_unlinked_doesNotRecompute", async () => {
    mp.companyCost.findUnique.mockResolvedValue({ id: "cc1", refId: null });
    await deleteEntry("cc1", actor);
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });
});

describe("togglePaid", () => {
  it("togglePaid_flipsCurrentValue", async () => {
    mp.companyCost.findUnique.mockResolvedValue({ id: "cc1", paid: false });
    await togglePaid("cc1");
    expect(mp.companyCost.update).toHaveBeenCalledWith({ where: { id: "cc1" }, data: { paid: true } });
  });

  it("togglePaid_missing_throws404", async () => {
    mp.companyCost.findUnique.mockResolvedValue(null);
    expect((await rejection(togglePaid("x"))).status).toBe(404);
  });
});

describe("createEntry - validation gaps", () => {
  it("createEntry_orderCodeNotFound_throws400", async () => {
    mp.order.findUnique.mockResolvedValue(null);
    const e = await rejection(createEntry({ ...base, orderCode: "OD404" }, actor));
    expect(e.toBody()).toEqual({ error: "BAD_REQUEST", message: "Không tìm thấy mã đơn này" });
  });

  it("createEntry_orderCodeWithoutTrackings_throws400", async () => {
    mp.order.findUnique.mockResolvedValue({ trackings: [] });
    const e = await rejection(createEntry({ ...base, orderCode: "OD1" }, actor));
    expect(e.message).toBe("Đơn chưa có tracking nào");
  });

  it("createEntry_bothTrackingAndOrderCode_trackingCodeWinsAndOrderNotLookedUp", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    const c = await createEntry({ ...base, trackingCode: "T1", orderCode: "OD1" }, actor);
    expect(c).toMatchObject({ refId: "t1" });
    expect(mp.order.findUnique).not.toHaveBeenCalled();
  });

  it("createEntry_chakubaraiWithBlankCodes_savedUnlinkedWithoutTouchingDebt", async () => {
    const c = await createEntry({ ...base, trackingCode: "  ", orderCode: "" }, actor);
    expect(c).toMatchObject({ refId: null, lateAfterLock: false });
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("createEntry_jpyWithZeroRate_throws400", async () => {
    const e = await rejection(createEntry({ ...base, kind: "other", currency: "JPY", exchangeRate: 0 }, actor));
    expect(e.message).toBe("Nhập JPY cần tỉ giá");
    expect(mp.companyCost.create).not.toHaveBeenCalled();
  });

  it("createEntry_success_writesCreatedAuditWithAmountAndRef", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    await createEntry({ ...base, trackingCode: "T1" }, { id: "u1", requestId: "r1" });
    expect((writeAudit as any).mock.calls[0][1]).toMatchObject({
      actorId: "u1", action: "company_cost.created", requestId: "r1", metadata: { kind: "chakubarai", amountVnd: 50000, refId: "t1", lateAfterLock: false },
    });
  });

  it("createEntry_linkedOrderVanishedBeforeLock_doesNotRecomputeOrQueueSheet", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    (lockOrder as any).mockResolvedValue(null);
    await createEntry({ ...base, trackingCode: "T1" }, actor);
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });
});

describe("deleteEntry - audit", () => {
  it("deleteEntry_success_writesDeletedAudit", async () => {
    mp.companyCost.findUnique.mockResolvedValue({ id: "cc1", refId: null });
    await deleteEntry("cc1", { id: "u1", requestId: "r1" });
    expect((writeAudit as any).mock.calls[0][1]).toEqual({ actorId: "u1", targetId: "cc1", action: "company_cost.deleted", requestId: "r1" });
  });

  it("deleteEntry_missing_doesNotDelete", async () => {
    mp.companyCost.findUnique.mockResolvedValue(null);
    await rejection(deleteEntry("x", actor));
    expect(mp.companyCost.delete).not.toHaveBeenCalled();
  });
});
