import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    tracking: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    order: { findUnique: vi.fn() },
    appConfig: { findUnique: vi.fn() },
    packDayLock: { upsert: vi.fn(), deleteMany: vi.fn() },
    weightRecon: { create: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../app/events/EventBus.js", () => ({ eventBus: { publish: vi.fn() } }));
vi.mock("../../middlewares/authorize.js", () => ({ loadPermissions: vi.fn() }));
vi.mock("../../integrations/google/googleSheets.client.js", () => ({ parseSheetId: vi.fn() }));
vi.mock("../orders/order.state.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../sheets/warehouseSheetSync.service.js", () => ({ syncPackedFromWarehouse: vi.fn(), setDayLockFromTab: vi.fn() }));
vi.mock("../sheets/warehousePackedOne.service.js", () => ({ syncPackedOne: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn(), queueTrackingSheetRow: vi.fn(), queueWarehouseRowClear: vi.fn() }));
vi.mock("../cartons/carton.service.js", async (orig) => ({ ...(await orig<object>()), deleteCartonIfEmpty: vi.fn() }));
vi.mock("../tracking/tracking.service.js", () => ({ assertTrackingDeletable: vi.fn(), queueOrderCustomerSync: vi.fn() }));
vi.mock("../tracking/tracking.repository.js", () => ({ claimOrCreateTracking: vi.fn() }));

import {
  weighVn, storeTrackings, addManualTracking, removeFromVnWarehouse, lockDay, unlockDay, resolveLateAfterLock,
  setVnTrackingCode, setJpWeight, reconcileOrderWeight, buildVnBoard, handleSyncHook,
} from "./warehouse.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";
import { loadPermissions } from "../../middlewares/authorize.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { setDayLockFromTab, syncPackedFromWarehouse } from "../sheets/warehouseSheetSync.service.js";
import { syncPackedOne } from "../sheets/warehousePackedOne.service.js";
import { queueCustomerSheetSync, queueTrackingSheetRow } from "../sheets/sheet.jobs.js";
import { deleteCartonIfEmpty } from "../cartons/carton.service.js";
import { queueOrderCustomerSync } from "../tracking/tracking.service.js";
import { claimOrCreateTracking } from "../tracking/tracking.repository.js";

const mp = prisma as any;
const mLoadPermissions = loadPermissions as ReturnType<typeof vi.fn>;
const mClaim = claimOrCreateTracking as ReturnType<typeof vi.fn>;
const staff = { id: "u1", requestId: "r1", roles: ["warehouse"] };
const NOW = new Date("2026-03-05T03:00:00.000Z");
const unlockedCarton = { declaredWeightKg: "10", vnTotalWeightKg: "10", weightConfirmedAt: null };
const lockedCarton = { declaredWeightKg: null, vnTotalWeightKg: null, weightConfirmedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("weighVn", () => {
  it("weighVn_unknownTracking_throws404NotFoundWithoutUpdating", async () => {
    mp.tracking.findUnique.mockResolvedValue(null);
    await expect(weighVn("t1", { vnWeightKg: 1 }, staff)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(mp.tracking.update).not.toHaveBeenCalled();
  });

  it("weighVn_jpWeightByStaffWithoutTrackingsUpdate_throws403Forbidden", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mLoadPermissions.mockResolvedValue(["warehouse.update"]);
    await expect(weighVn("t1", { jpWeightKg: 2 }, staff)).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(mp.tracking.update).not.toHaveBeenCalled();
  });

  it("weighVn_jpWeightByStaffWithTrackingsUpdate_updatesJpWeight", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mLoadPermissions.mockResolvedValue(["trackings.update"]);
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { jpWeightKg: 2 }, staff);
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { jpWeightKg: 2 } });
  });

  it("weighVn_jpWeightBySuperAdminWithNoExplicitPermission_updatesJpWeight", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mLoadPermissions.mockResolvedValue([]);
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { jpWeightKg: 2 }, { id: "sa", roles: ["super_admin"] });
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { jpWeightKg: 2 } });
  });

  it("weighVn_cartonLockedButOnlyVnTrackingCode_stillUpdates", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: "k1", carton: lockedCarton });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { vnTrackingCode: "VN1" }, staff);
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { vnTrackingCode: "VN1", deliveredAt: NOW } });
  });

  it.each([
    ["noCarton", null],
    ["cartonUnlocked", unlockedCarton],
  ])("weighVn_vnWeightWith_%s_updatesVnWeight", async (_name, carton) => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: carton ? "k1" : null, carton });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { vnWeightKg: 3.5 }, staff);
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { vnWeightKg: 3.5 } });
  });

  it("weighVn_replacingExistingVnTrackingCode_keepsDeliveredAtAndDoesNotBump", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: "VN_OLD", cartonId: null, carton: null });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: "o1" });
    await weighVn("t1", { vnTrackingCode: "VN_NEW" }, staff);
    expect(mp.tracking.update.mock.calls[0][0].data).toEqual({ vnTrackingCode: "VN_NEW" });
    expect(bumpOrderStatus).not.toHaveBeenCalled();
  });

  it("weighVn_trackingOfOrder_recomputesTotalsAndQueuesCustomerSync", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: "o1" });
    await weighVn("t1", { vnWeightKg: 1 }, staff);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1", expect.anything());
    expect(queueOrderCustomerSync).toHaveBeenCalledWith("o1");
  });

  it("weighVn_orphanTracking_skipsOrderRecomputeButQueuesSheetRow", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { vnWeightKg: 1 }, staff);
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
    expect(queueOrderCustomerSync).not.toHaveBeenCalled();
    expect(queueTrackingSheetRow).toHaveBeenCalledWith("t1");
  });

  it("weighVn_success_publishesTrackingUpdatedWithChangedFieldNames", async () => {
    mp.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mp.tracking.update.mockResolvedValue({ id: "t1", orderId: null });
    await weighVn("t1", { vnWeightKg: 1, vnTrackingCode: "VN1" }, staff);
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "tracking.updated", actorId: "u1", entityId: "t1", metadata: { fields: ["vnWeightKg", "vnTrackingCode"] },
    }));
  });
});

describe("storeTrackings", () => {
  it("storeTrackings_givenIds_returnsCountAndAuditsStore", async () => {
    mp.tracking.findMany.mockResolvedValue([]);
    const r = await storeTrackings(["t1", "t2"], staff);
    expect(r).toEqual({ stored: 2 });
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", action: "warehouse.store", metadata: { count: 2 }, requestId: "r1" });
  });

  it("storeTrackings_orphansAndSharedCustomer_bumpsDistinctOrdersAndSyncsEachCustomerOnce", async () => {
    mp.tracking.findMany.mockResolvedValue([
      { orderId: "o1", order: { customerId: "c1" } },
      { orderId: "o1", order: { customerId: "c1" } },
      { orderId: null, order: null },
    ]);
    await storeTrackings(["t1", "t2", "t3"], staff);
    expect(bumpOrderStatus).toHaveBeenCalledWith(["o1"], "vn_warehouse", expect.anything());
    expect(queueCustomerSheetSync).toHaveBeenCalledTimes(1);
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("storeTrackings_givenIds_publishesStoredEventPerTracking", async () => {
    mp.tracking.findMany.mockResolvedValue([]);
    await storeTrackings(["t1", "t2"], staff);
    expect(eventBus.publish).toHaveBeenCalledTimes(2);
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "tracking.updated", entityId: "t2", metadata: { status: "stored" } }));
  });
});

describe("addManualTracking", () => {
  it("addManualTracking_unknownOrderCode_throws404OrderNotFound", async () => {
    mp.order.findUnique.mockResolvedValue(null);
    await expect(addManualTracking({ orderCode: "X", code: "T1" }, staff)).rejects.toMatchObject({ status: 404, code: "ORDER_NOT_FOUND" });
    expect(mClaim).not.toHaveBeenCalled();
  });

  it("addManualTracking_paddedOrderCode_looksUpTrimmedCode", async () => {
    mp.order.findUnique.mockResolvedValue(null);
    await addManualTracking({ orderCode: "  OD1 ", code: "T1" }, staff).catch(() => undefined);
    expect(mp.order.findUnique).toHaveBeenCalledWith({ where: { code: "OD1" }, select: { id: true, customerId: true } });
  });

  it("addManualTracking_orderAlreadyHasCodeWithPackedAt_updatesKeepingPackedAt", async () => {
    const packedAt = new Date("2026-03-01T00:00:00Z");
    mp.order.findUnique.mockResolvedValue({ id: "o1", customerId: "c1" });
    mp.tracking.findFirst.mockResolvedValue({ id: "t9", packedAt });
    mp.tracking.update.mockResolvedValue({ id: "t9" });
    await addManualTracking({ orderCode: "OD1", code: " T1 ", jpWeightKg: 1.2, cartonId: "k1" }, staff);
    expect(mp.tracking.findFirst).toHaveBeenCalledWith({ where: { orderId: "o1", code: "T1" } });
    expect(mp.tracking.update).toHaveBeenCalledWith({
      where: { id: "t9" },
      data: { jpWeightKg: 1.2, cartonId: "k1", cartonManual: true, packedAt, status: "linked" },
    });
    expect(mClaim).not.toHaveBeenCalled();
  });

  it("addManualTracking_existingCodeNeverPacked_setsPackedAtNow", async () => {
    mp.order.findUnique.mockResolvedValue({ id: "o1", customerId: "c1" });
    mp.tracking.findFirst.mockResolvedValue({ id: "t9", packedAt: null });
    mp.tracking.update.mockResolvedValue({ id: "t9" });
    await addManualTracking({ orderCode: "OD1", code: "T1" }, staff);
    expect(mp.tracking.update.mock.calls[0][0].data).toMatchObject({ packedAt: NOW, cartonManual: false });
  });

  it("addManualTracking_codeNotOnOrder_claimsOrCreatesTracking", async () => {
    mp.order.findUnique.mockResolvedValue({ id: "o1", customerId: "c1" });
    mp.tracking.findFirst.mockResolvedValue(null);
    mClaim.mockResolvedValue({ id: "t2" });
    const t = await addManualTracking({ orderCode: "OD1", code: "T1", jpWeightKg: 0.5 }, staff);
    expect(t).toEqual({ id: "t2" });
    expect(mClaim).toHaveBeenCalledWith("o1", "T1", { jpWeightKg: 0.5, cartonId: undefined, cartonManual: false, packedAt: NOW }, expect.anything());
    expect(mp.tracking.update).not.toHaveBeenCalled();
  });

  it("addManualTracking_success_recomputesTotalsAndQueuesSheets", async () => {
    mp.order.findUnique.mockResolvedValue({ id: "o1", customerId: "c1" });
    mp.tracking.findFirst.mockResolvedValue(null);
    mClaim.mockResolvedValue({ id: "t2" });
    await addManualTracking({ orderCode: "OD1", code: "T1" }, staff);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1", expect.anything());
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
    expect(queueTrackingSheetRow).toHaveBeenCalledWith("t2");
  });

  it("addManualTracking_success_auditsRawInputAndPublishesAssigned", async () => {
    mp.order.findUnique.mockResolvedValue({ id: "o1", customerId: "c1" });
    mp.tracking.findFirst.mockResolvedValue(null);
    mClaim.mockResolvedValue({ id: "t2" });
    await addManualTracking({ orderCode: "OD1", code: "T1 " }, staff);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "u1", targetId: "t2", action: "warehouse.tracking_added_manual", metadata: { orderCode: "OD1", code: "T1 " },
    }));
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "tracking.assigned", entityId: "t2", metadata: { orderId: "o1" } }));
  });
});

describe("removeFromVnWarehouse", () => {
  it("removeFromVnWarehouse_orphan_deletesLogsThenTrackingAndAuditsDeleted", async () => {
    mp.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: null, code: "TRK1", cartonId: null, packedAt: null, packRow: null });
    await removeFromVnWarehouse("t1", staff);
    expect(mp.trackingLog.deleteMany).toHaveBeenCalledWith({ where: { trackingId: "t1" } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "t1", action: "tracking.deleted", metadata: { code: "TRK1" } }));
    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it("removeFromVnWarehouse_trackingOfOrder_recomputesSyncsAuditsAndPublishesUnpacked", async () => {
    mp.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", code: "TRK1", cartonId: "k1", packedAt: null, packRow: null });
    await removeFromVnWarehouse("t1", staff);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1", expect.anything());
    expect(queueOrderCustomerSync).toHaveBeenCalledWith("o1");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "warehouse.tracking_unpacked", metadata: { code: "TRK1" } }));
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "tracking.updated", entityId: "t1", metadata: { unpacked: true } }));
  });

  it("removeFromVnWarehouse_trackingOfOrderInCarton_deletesCartonIfNowEmpty", async () => {
    mp.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", code: "TRK1", cartonId: "k1", packedAt: null, packRow: null });
    await removeFromVnWarehouse("t1", staff);
    expect(deleteCartonIfEmpty).toHaveBeenCalledWith("k1");
  });
});

describe("lockDay / unlockDay", () => {
  it("lockDay_givenDate_upsertsLockWithoutOverwritingExistingLocker", async () => {
    mp.packDayLock.upsert.mockResolvedValue({ date: "x" });
    await lockDay("2026-03-05", staff);
    expect(mp.packDayLock.upsert).toHaveBeenCalledWith({
      where: { date: new Date(2026, 2, 5) }, update: {}, create: { date: new Date(2026, 2, 5), lockedBy: "u1" },
    });
  });

  it("lockDay_givenDate_auditsDayLockAndReturnsRow", async () => {
    mp.packDayLock.upsert.mockResolvedValue({ lockedBy: "u1" });
    const row = await lockDay("2026-03-05", staff);
    expect(row).toEqual({ lockedBy: "u1" });
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", action: "warehouse.day_lock", metadata: { date: "2026-03-05" }, requestId: "r1" });
  });

  it("unlockDay_givenDate_deletesLockAndAuditsUnlock", async () => {
    await unlockDay("2026-03-05", staff);
    expect(mp.packDayLock.deleteMany).toHaveBeenCalledWith({ where: { date: new Date(2026, 2, 5) } });
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", action: "warehouse.day_unlock", metadata: { date: "2026-03-05" }, requestId: "r1" });
  });
});

describe("resolveLateAfterLock", () => {
  it("resolveLateAfterLock_givenId_clearsLateFlag", async () => {
    await resolveLateAfterLock("t1");
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { lateAfterLock: false } });
  });
});

describe("setVnTrackingCode / setJpWeight", () => {
  it("setVnTrackingCode_givenCode_updatesQueuesRowAuditsAndPublishes", async () => {
    mp.tracking.update.mockResolvedValue({ id: "t1" });
    await setVnTrackingCode("t1", "VN9", staff);
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { vnTrackingCode: "VN9" } });
    expect(queueTrackingSheetRow).toHaveBeenCalledWith("t1");
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "t1", action: "warehouse.vn_tracking_set" }));
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "tracking.updated", metadata: { vnTrackingCode: "VN9" } }));
  });

  it("setJpWeight_givenWeight_updatesAndAuditsJpWeighed", async () => {
    mp.tracking.update.mockResolvedValue({ id: "t1", jpWeightKg: 1.5 });
    const t = await setJpWeight("t1", 1.5, staff);
    expect(t).toEqual({ id: "t1", jpWeightKg: 1.5 });
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { jpWeightKg: 1.5 } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "t1", action: "warehouse.jp_weighed" }));
  });
});

describe("reconcileOrderWeight", () => {
  it("reconcileOrderWeight_nullJpWeightsCountAsZero_storesDiffAgainstSum", async () => {
    mp.tracking.findMany.mockResolvedValue([{ jpWeightKg: "1.25" }, { jpWeightKg: "2.5" }, { jpWeightKg: null }]);
    await reconcileOrderWeight({ orderId: "o1", vnWeight: 4, note: "n" }, staff);
    expect(mp.weightRecon.create.mock.calls[0][0].data).toMatchObject({ orderId: "o1", jpWeight: 3.75, vnWeight: 4, diffKg: 0.25, note: "n" });
  });

  it("reconcileOrderWeight_floatSumNoise_roundsDiffTo3Decimals", async () => {
    mp.tracking.findMany.mockResolvedValue([{ jpWeightKg: "0.1" }, { jpWeightKg: "0.2" }]);
    await reconcileOrderWeight({ orderId: "o1", vnWeight: 1 }, staff);
    expect(mp.weightRecon.create.mock.calls[0][0].data.diffKg).toBe(0.7);
  });

  it("reconcileOrderWeight_vnLighterThanJp_storesNegativeDiff", async () => {
    mp.tracking.findMany.mockResolvedValue([{ jpWeightKg: "5" }]);
    await reconcileOrderWeight({ orderId: "o1", vnWeight: 4.5 }, staff);
    expect(mp.weightRecon.create.mock.calls[0][0].data.diffKg).toBe(-0.5);
  });

  it("reconcileOrderWeight_success_auditsWeighedWithDiff", async () => {
    mp.tracking.findMany.mockResolvedValue([{ jpWeightKg: "5" }]);
    await reconcileOrderWeight({ orderId: "o1", vnWeight: 6 }, staff);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      targetId: "o1", action: "warehouse.vn_weighed", metadata: { jpWeight: 5, vnWeight: 6, diff: 1 },
    }));
  });
});

const trk = (id: string, packedAt: string | null, jp: string | null = null, vn: string | null = null) =>
  ({ id, packedAt: packedAt ? new Date(packedAt) : null, jpWeightKg: jp, vnWeightKg: vn });
const carton = (o: Record<string, unknown>) => ({
  id: "k1", code: "GE 1", note: null, packedDate: null, declaredWeightKg: null, vnTotalWeightKg: null, weightConfirmedAt: null,
  electronicsCount: null, electronicsConfirmedAt: null, trackings: [], _count: { trackings: 0 }, ...o,
});

describe("buildVnBoard", () => {
  it("buildVnBoard_cartonWithPackedDate_groupsUnderPackedDateDay", () => {
    const days = buildVnBoard([[carton({ packedDate: new Date("2026-03-04T00:00:00Z"), trackings: [trk("t1", "2026-03-01T00:00:00Z")], _count: { trackings: 1 } })], []] as any);
    expect(days.map((d) => d.day)).toEqual(["2026-03-04"]);
  });

  it("buildVnBoard_cartonWithoutPackedDate_usesEarliestTrackingDay", () => {
    const trackings = [trk("t1", "2026-03-03T00:00:00Z"), trk("t2", "2026-03-02T00:00:00Z")];
    const days = buildVnBoard([[carton({ trackings, _count: { trackings: 2 } })], []] as any);
    expect(days.map((d) => d.day)).toEqual(["2026-03-02"]);
  });

  it("buildVnBoard_newEmptyCartonWithoutDates_groupsUnderNoDay", () => {
    const days = buildVnBoard([[carton({})], []] as any);
    expect(days.map((d) => d.day)).toEqual(["0000-00-00"]);
    expect(days[0].cartons[0].count).toBe(0);
  });

  it("buildVnBoard_cartonFullyMovedToStorage_isHiddenAndEmptyDayDropped", () => {
    const days = buildVnBoard([[carton({ packedDate: new Date("2026-03-04T00:00:00Z"), trackings: [], _count: { trackings: 3 } })], []] as any);
    expect(days).toEqual([]);
  });

  it("buildVnBoard_trackingWeights_actualKgPrefersVnAndDiffVsDeclaredRounded", () => {
    const trackings = [trk("t1", "2026-03-04T00:00:00Z", "1.1", null), trk("t2", "2026-03-04T00:00:00Z", "9", "2.2")];
    const days = buildVnBoard([[carton({ declaredWeightKg: "3", trackings, _count: { trackings: 2 } })], []] as any);
    expect(days[0].cartons[0]).toMatchObject({ actualKg: 3.3, diffKg: 0.3, declaredWeightKg: 3 });
  });

  it("buildVnBoard_noDeclaredWeight_diffIsNullAndCartonLocked", () => {
    const days = buildVnBoard([[carton({ trackings: [trk("t1", "2026-03-04T00:00:00Z", "1")], _count: { trackings: 1 } })], []] as any);
    expect(days[0].cartons[0]).toMatchObject({ diffKg: null, weightLocked: true });
  });

  it("buildVnBoard_matchingTotals_cartonNotLocked", () => {
    const c = carton({ declaredWeightKg: "5", vnTotalWeightKg: "5.2", trackings: [trk("t1", "2026-03-04T00:00:00Z")], _count: { trackings: 1 } });
    const days = buildVnBoard([[c], []] as any);
    expect(days[0].cartons[0]).toMatchObject({ weightLocked: false, vnTotalWeightKg: 5.2 });
  });

  it("buildVnBoard_looseTrackings_listedAsUnassignedOfTheirDaySortedNewestFirst", () => {
    const loose = [trk("a", "2026-03-01T05:00:00Z"), trk("b", "2026-03-05T05:00:00Z")];
    const days = buildVnBoard([[], loose] as any);
    expect(days.map((d) => [d.day, d.unassigned.map((t: any) => t.id)])).toEqual([["2026-03-05", ["b"]], ["2026-03-01", ["a"]]]);
  });
});

describe("handleSyncHook", () => {
  beforeEach(() => mp.appConfig.findUnique.mockResolvedValue({ value: "secret" }));

  it("handleSyncHook_secondCandidateKeyMatches_accepted", async () => {
    mp.appConfig.findUnique.mockResolvedValue({ value: "secret" });
    (syncPackedFromWarehouse as ReturnType<typeof vi.fn>).mockResolvedValue({ matched: 0 });
    await expect(handleSyncHook(["", "wrong", "secret"], {})).resolves.toEqual({ matched: 0 });
  });

  it("handleSyncHook_dayLockNotBoolean_doesNotToggleLockAndFallsBackToScan", async () => {
    await handleSyncHook(["secret"], { dayLock: "true", tab: "05/03" });
    expect(setDayLockFromTab).not.toHaveBeenCalled();
    expect(syncPackedFromWarehouse).toHaveBeenCalledWith({ recentDays: 45 });
  });

  it("handleSyncHook_dayLockWithoutTab_doesNotToggleLock", async () => {
    await handleSyncHook(["secret"], { dayLock: false });
    expect(setDayLockFromTab).not.toHaveBeenCalled();
  });

  it("handleSyncHook_codeOnly_syncsOneWithUndefinedLocation", async () => {
    await handleSyncHook(["secret"], { code: "TRK1" });
    expect(syncPackedOne).toHaveBeenCalledWith("TRK1", undefined, undefined, undefined, undefined);
  });

  it("handleSyncHook_emptyCandidateList_throws401BadKey", async () => {
    await expect(handleSyncHook([], { code: "TRK1" })).rejects.toMatchObject({ status: 401, code: "BAD_KEY" });
  });
});
