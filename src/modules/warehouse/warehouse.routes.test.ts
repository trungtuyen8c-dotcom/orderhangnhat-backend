import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../../app/errors/errorHandler.js";

vi.mock("../../infrastructure/prisma.js", () => {
  const prisma: any = {
    tracking: { updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    order: { findUnique: vi.fn() },
    appConfig: { findUnique: vi.fn() },
    companyCost: { count: vi.fn() },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "actor1", roles: ["staff"] }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
  loadPermissions: vi.fn(),
}));
vi.mock("../orders/order.state.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../integrations/google/googleSheets.client.js", () => ({ parseSheetId: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({
  queueCustomerSheetSync: vi.fn(), queueTrackingSheetRow: vi.fn(), queueTrackingSheetRowRemoval: vi.fn(), queueWarehouseRowClear: vi.fn(),
}));
vi.mock("../sheets/orphanTracking.js", () => ({ createOrphanTrackingSafe: vi.fn() }));
vi.mock("../sheets/warehouseSheetSync.service.js", () => ({
  syncPackedFromWarehouse: vi.fn(), setDayLockFromTab: vi.fn(), clearWarehouseRow: vi.fn(),
}));
vi.mock("../sheets/warehousePackedOne.service.js", () => ({ syncPackedOne: vi.fn() }));
vi.mock("../cartons/carton.service.js", async (orig) => ({ ...(await orig<object>()), deleteCartonIfEmpty: vi.fn() }));
vi.mock("../tracking/tracking.repository.js", async (orig) => ({ ...(await orig<object>()), claimOrCreateTracking: vi.fn() }));

import { warehouseRouter } from "./warehouse.routes.js";
import { dayKey, effKg, hookKeyMatches } from "./warehouse.service.js";
import { cartonWeightLocked, deleteCartonIfEmpty } from "../cartons/carton.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { queueCustomerSheetSync, queueWarehouseRowClear } from "../sheets/sheet.jobs.js";
import { syncPackedOne } from "../sheets/warehousePackedOne.service.js";
import { syncPackedFromWarehouse, setDayLockFromTab } from "../sheets/warehouseSheetSync.service.js";

const mockPrisma = prisma as unknown as {
  tracking: {
    updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>;
  };
  trackingLog: { deleteMany: ReturnType<typeof vi.fn> };
  order: { findUnique: ReturnType<typeof vi.fn> };
  appConfig: { findUnique: ReturnType<typeof vi.fn> };
  companyCost: { count: ReturnType<typeof vi.fn> };
};
const mockBumpOrderStatus = bumpOrderStatus as ReturnType<typeof vi.fn>;
const mockSyncCustomerOrders = queueCustomerSheetSync as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/warehouse", warehouseRouter);
  app.use(errorHandler);
  return app;
}

describe("dayKey", () => {
  it("dayKey_nullDate_returnsNull", () => {
    expect(dayKey(null)).toBeNull();
  });

  it("dayKey_validDate_returnsIsoDateSlice", () => {
    expect(dayKey(new Date("2026-03-05T10:00:00.000Z"))).toBe("2026-03-05");
  });
});

describe("effKg", () => {
  it("effKg_vnWeightPresent_returnsVnWeight", () => {
    expect(effKg({ vnWeightKg: "5.5", jpWeightKg: "6" })).toBe(5.5);
  });

  it("effKg_vnWeightNullJpWeightPresent_returnsJpWeight", () => {
    expect(effKg({ vnWeightKg: null, jpWeightKg: "6" })).toBe(6);
  });

  it("effKg_bothNull_returnsZero", () => {
    expect(effKg({ vnWeightKg: null, jpWeightKg: null })).toBe(0);
  });
});

describe("cartonWeightLocked", () => {
  it("cartonWeightLocked_missingDeclaredWeight_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: null, vnTotalWeightKg: "5", weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_missingVnTotalWeight_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: null, weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_weightsMatchExactly_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "5", weightConfirmedAt: null })).toBe(false);
  });

  it("cartonWeightLocked_weightsDiffBelowThreshold_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "5.9", weightConfirmedAt: null })).toBe(false);
  });

  it("cartonWeightLocked_weightsDiffAtThresholdUnconfirmed_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "6", weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_weightsDiffAboveThresholdButConfirmed_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "7", weightConfirmedAt: new Date() })).toBe(false);
  });
});

describe("POST /warehouse/store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.tracking.updateMany.mockResolvedValue({ count: 1 });
  });

  it("warehouseStore_givenTrackingIds_setsStoredAtOnlyForNeverStoredAndBumpsOrderToVnWarehouse", async () => {
    mockPrisma.tracking.findMany.mockResolvedValue([
      { orderId: "o1", order: { customerId: "c1" } },
      { orderId: "o2", order: { customerId: "c2" } },
    ]);
    await request(buildApp()).post("/api/warehouse/store").send({ ids: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] }).expect(200);

    const calls = mockPrisma.tracking.updateMany.mock.calls;
    expect(calls[0][0]).toEqual({ where: { id: { in: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] }, storedAt: null }, data: { status: "stored", storedAt: expect.any(Date) } });
    expect(calls[1][0]).toEqual({ where: { id: { in: ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"] }, storedAt: { not: null } }, data: { status: "stored" } });
    expect(mockBumpOrderStatus).toHaveBeenCalledWith(["o1", "o2"], "vn_warehouse", expect.anything());
    expect(mockSyncCustomerOrders).toHaveBeenCalledWith("c1");
    expect(mockSyncCustomerOrders).toHaveBeenCalledWith("c2");
  });

  it("warehouseStore_emptyIdsArray_returns400BadRequest", async () => {
    await request(buildApp()).post("/api/warehouse/store").send({ ids: [] }).expect(400);
    expect(mockPrisma.tracking.updateMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /warehouse/tracking/:id/vn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.findUnique.mockResolvedValue({ customerId: "c1" });
  });

  it("warehousePatchVn_settingVnTrackingCodeFirstTime_setsDeliveredAtAndBumpsOrderToDelivered", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue({ vnTrackingCode: null, cartonId: null, carton: null });
    mockPrisma.tracking.update.mockResolvedValue({ id: "t1", orderId: "o1", vnTrackingCode: "VN123" });

    await request(buildApp()).patch("/api/warehouse/tracking/t1/vn").send({ vnTrackingCode: "VN123" }).expect(200);

    expect(mockPrisma.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { vnTrackingCode: "VN123", deliveredAt: expect.any(Date) } });
    expect(mockBumpOrderStatus).toHaveBeenCalledWith("o1", "delivered", expect.anything());
  });

  it("warehousePatchVn_clearingVnTrackingCode_nullsDeliveredAtAndDoesNotBumpStatus", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue({ vnTrackingCode: "VN123", cartonId: null, carton: null });
    mockPrisma.tracking.update.mockResolvedValue({ id: "t1", orderId: "o1", vnTrackingCode: "" });

    await request(buildApp()).patch("/api/warehouse/tracking/t1/vn").send({ vnTrackingCode: "" }).expect(200);

    expect(mockPrisma.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { vnTrackingCode: "", deliveredAt: null } });
    expect(mockBumpOrderStatus).not.toHaveBeenCalled();
  });

  it("warehousePatchVn_cartonWeightLockedAndSettingVnWeight_returns423CartonLocked", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue({
      vnTrackingCode: null, cartonId: "ct1",
      carton: { declaredWeightKg: null, vnTotalWeightKg: null, weightConfirmedAt: null },
    });
    await request(buildApp()).patch("/api/warehouse/tracking/t1/vn").send({ vnWeightKg: 5 }).expect(423);
    expect(mockPrisma.tracking.update).not.toHaveBeenCalled();
    expect(mockBumpOrderStatus).not.toHaveBeenCalled();
  });
});

describe("hookKeyMatches", () => {
  it("hookKeyMatches_sameKey_returnsTrue", () => {
    expect(hookKeyMatches("abc123", "abc123")).toBe(true);
  });

  it("hookKeyMatches_differentKeyOrLength_returnsFalse", () => {
    expect(hookKeyMatches("abc124", "abc123")).toBe(false);
    expect(hookKeyMatches("abc", "abc123")).toBe(false);
  });

  it("hookKeyMatches_emptyCandidate_returnsFalse", () => {
    expect(hookKeyMatches("", "abc123")).toBe(false);
  });
});

describe("POST /warehouse/sync-hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.appConfig.findUnique.mockResolvedValue({ key: "warehouse_hook_key", value: "secret-key" });
  });

  it("syncHook_keyInQueryString_acceptsForBackwardCompatAndReturnsMatchResult", async () => {
    (syncPackedOne as ReturnType<typeof vi.fn>).mockResolvedValue({ matched: true });
    const r = await request(buildApp()).post("/api/warehouse/sync-hook?key=secret-key").send({ code: "TRK1", tab: "05/03", row: "7", bill: "GA", thung: "2" }).expect(200);
    expect(r.body).toEqual({ matched: true });
    expect(syncPackedOne).toHaveBeenCalledWith("TRK1", "05/03", 7, "GA", "2");
  });

  it("syncHook_keyInWarehouseWebhookHeader_accepted", async () => {
    (syncPackedFromWarehouse as ReturnType<typeof vi.fn>).mockResolvedValue({ matched: 1, updated: 2 });
    const r = await request(buildApp()).post("/api/warehouse/sync-hook").set("X-Warehouse-Webhook-Key", "secret-key").send({}).expect(200);
    expect(r.body).toEqual({ matched: 1, updated: 2 });
    expect(syncPackedFromWarehouse).toHaveBeenCalledWith({ recentDays: 45 });
  });

  it("syncHook_legacyXHookKeyHeader_accepted", async () => {
    await request(buildApp()).post("/api/warehouse/sync-hook").set("X-Hook-Key", "secret-key").send({ dayLock: true, tab: "05/03" }).expect(200, { ok: true });
    expect(setDayLockFromTab).toHaveBeenCalledWith("05/03", true);
  });

  it("syncHook_wrongKey_returns401BadKey", async () => {
    await request(buildApp()).post("/api/warehouse/sync-hook?key=nope").send({ code: "TRK1" }).expect(401, { error: "BAD_KEY" });
    expect(syncPackedOne).not.toHaveBeenCalled();
  });

  it("syncHook_noKeyConfigured_returns401BadKey", async () => {
    mockPrisma.appConfig.findUnique.mockResolvedValue(null);
    await request(buildApp()).post("/api/warehouse/sync-hook").send({}).expect(401, { error: "BAD_KEY" });
  });
});

describe("DELETE /warehouse/tracking/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.companyCost.count.mockResolvedValue(0);
  });

  it("removeFromVn_orphanTracking_deletesTrackingAndClearsSheetRow", async () => {
    const packedAt = new Date("2026-03-05T00:00:00Z");
    mockPrisma.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: null, code: "TRK1", cartonId: "c1", packedAt, packRow: 7 });
    await request(buildApp()).delete("/api/warehouse/tracking/t1").expect(200, { ok: true });
    expect(mockPrisma.tracking.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(queueWarehouseRowClear).toHaveBeenCalledWith(packedAt, 7);
    expect(deleteCartonIfEmpty).toHaveBeenCalledWith("c1");
  });

  it("removeFromVn_trackingOfRealOrder_onlyUnpacksAndKeepsOrderData", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", code: "TRK1", cartonId: null, packedAt: null, packRow: null });
    mockPrisma.order.findUnique.mockResolvedValue({ customerId: "c1" });
    await request(buildApp()).delete("/api/warehouse/tracking/t1").expect(200);
    expect(mockPrisma.tracking.delete).not.toHaveBeenCalled();
    expect(mockPrisma.tracking.update.mock.calls[0][0].data).toMatchObject({ packedAt: null, cartonId: null, vnTrackingCode: null, status: "linked", deliveredAt: null });
    expect(mockSyncCustomerOrders).toHaveBeenCalledWith("c1");
  });

  it("removeFromVn_orphanWithChakubaraiCompanyCost_returns409AndDoesNotDelete", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: null, code: "TRK1", cartonId: null, packedAt: null, packRow: null });
    mockPrisma.companyCost.count.mockResolvedValue(1);
    const r = await request(buildApp()).delete("/api/warehouse/tracking/t1").expect(409);
    expect(r.body.error).toBe("TRACKING_HAS_COMPANY_COST");
    expect(mockPrisma.tracking.delete).not.toHaveBeenCalled();
  });

  it("removeFromVn_unknownId_returns404", async () => {
    mockPrisma.tracking.findUnique.mockResolvedValue(null);
    await request(buildApp()).delete("/api/warehouse/tracking/nope").expect(404, { error: "NOT_FOUND" });
  });
});
