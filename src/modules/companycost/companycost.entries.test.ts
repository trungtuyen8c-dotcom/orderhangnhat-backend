import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    tracking: { findFirst: vi.fn(), findUnique: vi.fn() },
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
import { LegacyError } from "../../app/http/legacyError.js";

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
  try { await p; } catch (e) { return e as LegacyError; }
  throw new Error("expected rejection");
}

describe("createEntry", () => {
  it("createEntry_chakubaraiByTracking_createsCostRecomputesDebtInSameTxThenQueuesSheetAfterCommit", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: "o1" });
    const c = await createEntry({ ...base, trackingCode: " T1 " }, actor);
    expect(mp.tracking.findFirst).toHaveBeenCalledWith({ where: { code: "T1" }, select: { id: true, orderId: true } });
    expect(c).toMatchObject({ refId: "t1", amountVnd: 50000, lateAfterLock: false });
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1", mp);
    expect(order).toEqual(["tx:start", "create", "lock", "recompute", "audit", "tx:commit", "queue"]);
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("createEntry_trackingNotFound_throws400WithMessageAndWritesNothing", async () => {
    mp.tracking.findFirst.mockResolvedValue(null);
    const e = await rejection(createEntry({ ...base, trackingCode: "X" }, actor));
    expect(e.toBody()).toEqual({ error: "BAD_REQUEST", message: "Không tìm thấy mã tracking này" });
    expect(mp.companyCost.create).not.toHaveBeenCalled();
  });

  it("createEntry_trackingWithoutOrder_throws400", async () => {
    mp.tracking.findFirst.mockResolvedValue({ id: "t1", orderId: null });
    const e = await rejection(createEntry({ ...base, trackingCode: "T1" }, actor));
    expect(e.message).toBe("Mã tracking chưa gắn đơn nào");
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

  it("createEntry_jpyWithoutRate_throws400", async () => {
    const e = await rejection(createEntry({ ...base, currency: "JPY" }, actor));
    expect(e.toBody()).toEqual({ error: "BAD_REQUEST", message: "Nhập JPY cần tỉ giá" });
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
