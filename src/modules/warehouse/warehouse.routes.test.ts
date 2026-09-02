import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../db.js", () => ({
  prisma: {
    tracking: { updateMany: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn() },
  },
}));
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "actor1", roles: ["staff"] }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
  loadPermissions: vi.fn(),
}));
vi.mock("../../utils/orderStatus.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../../utils/orderTotals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../../utils/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../utils/gsheets.js", () => ({
  syncTracking: vi.fn(), syncPackedFromWarehouse: vi.fn(), syncPackedOne: vi.fn(),
  parseSheetId: vi.fn(), syncCustomerOrders: vi.fn(), setDayLockFromTab: vi.fn(), clearWarehouseRow: vi.fn(),
}));
vi.mock("../../utils/cartons.js", () => ({ deleteCartonIfEmpty: vi.fn() }));
vi.mock("../../utils/trackingClaim.js", () => ({ claimOrCreateTracking: vi.fn() }));

import { dayKey, effKg, cartonWeightLocked, warehouseRouter } from "./warehouse.routes.js";
import { prisma } from "../../db.js";
import { bumpOrderStatus } from "../../utils/orderStatus.js";
import { syncCustomerOrders } from "../../utils/gsheets.js";

const mockPrisma = prisma as unknown as {
  tracking: {
    updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>;
  };
  order: { findUnique: ReturnType<typeof vi.fn> };
};
const mockBumpOrderStatus = bumpOrderStatus as ReturnType<typeof vi.fn>;
const mockSyncCustomerOrders = syncCustomerOrders as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/warehouse", warehouseRouter);
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
    expect(mockBumpOrderStatus).toHaveBeenCalledWith(["o1", "o2"], "vn_warehouse");
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
    expect(mockBumpOrderStatus).toHaveBeenCalledWith("o1", "delivered");
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
