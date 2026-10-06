import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../../app/errors/errorHandler.js";

vi.mock("../../infrastructure/prisma.js", () => {
  const prisma: any = {
    tracking: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    trackingLog: { create: vi.fn(), deleteMany: vi.fn() },
    order: { findUnique: vi.fn() },
    companyCost: { count: vi.fn() },
  };
  prisma.$transaction = vi.fn((fn: (tx: unknown) => unknown) => fn(prisma));
  return { prisma };
});
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "actor1", roles: ["staff"] }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({ authorize: () => (_req: any, _res: any, next: any) => next() }));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({
  queueCustomerSheetSync: vi.fn(), queueTrackingSheetRow: vi.fn(), queueTrackingSheetRowRemoval: vi.fn(),
}));
vi.mock("../sheets/orphanTracking.js", () => ({ createOrphanTrackingSafe: vi.fn() }));
vi.mock("../scrape/scrape.service.js", () => ({ scrapeProduct: vi.fn() }));
vi.mock("../cartons/carton.service.js", () => ({ deleteCartonIfEmpty: vi.fn() }));
vi.mock("./tracking.repository.js", async (orig) => ({ ...(await orig<object>()), claimOrCreateTracking: vi.fn() }));

import { trackingRouter } from "./tracking.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { queueCustomerSheetSync, queueTrackingSheetRowRemoval } from "../sheets/sheet.jobs.js";
import { claimOrCreateTracking } from "./tracking.repository.js";
import { deleteCartonIfEmpty } from "../cartons/carton.service.js";

const db = prisma as any;
const mockClaim = claimOrCreateTracking as ReturnType<typeof vi.fn>;
const mockRecompute = recomputeOrderTotals as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/trackings", trackingRouter);
  app.use(errorHandler);
  return app;
}

describe("GET /trackings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listTrackings_noPageParam_returnsPlainArrayCappedAt500", async () => {
    db.tracking.findMany.mockResolvedValue([{ id: "t1" }]);
    const r = await request(buildApp()).get("/api/trackings?stock=1").expect(200);
    expect(r.body).toEqual([{ id: "t1" }]);
    const arg = db.tracking.findMany.mock.calls[0][0];
    expect(arg.take).toBe(500);
    expect(arg.where).toEqual({ packedAt: { not: null }, OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }] });
    expect(db.tracking.count).not.toHaveBeenCalled();
  });

  it("listTrackings_pageGiven_returnsItemsWithPagination", async () => {
    db.tracking.findMany.mockResolvedValue([{ id: "t3" }]);
    db.tracking.count.mockResolvedValue(21);
    const r = await request(buildApp()).get("/api/trackings?page=2&pageSize=10").expect(200);
    expect(r.body).toEqual({ items: [{ id: "t3" }], pagination: { page: 2, pageSize: 10, total: 21, totalPages: 3 } });
    expect(db.tracking.findMany.mock.calls[0][0]).toMatchObject({ skip: 10, take: 10, orderBy: [{ createdAt: "desc" }] });
  });

  it("listTrackings_searchStatusAndSort_appliedToListAndCount", async () => {
    db.tracking.findMany.mockResolvedValue([]);
    db.tracking.count.mockResolvedValue(0);
    await request(buildApp()).get("/api/trackings?stock=1&q=ab&status=new,weighed&sort=code&order=asc&page=1&pageSize=50").expect(200);
    const arg = db.tracking.findMany.mock.calls[0][0];
    const c = { contains: "ab", mode: "insensitive" };
    expect(arg.where).toEqual({
      packedAt: { not: null }, OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }],
      status: { in: ["new", "weighed"] },
      AND: [{ OR: [{ code: c }, { jpName: c }, { order: { code: c } }, { order: { customer: { name: c } } }] }],
    });
    expect(arg.orderBy).toEqual([{ code: "asc" }, { createdAt: "desc" }]);
    expect(db.tracking.count).toHaveBeenCalledWith({ where: arg.where });
  });

  it("listTrackings_invalidSort_returns400", async () => {
    await request(buildApp()).get("/api/trackings?sort=weight").expect(400);
    expect(db.tracking.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /trackings/bulk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bulk_mixOfEmptySlotOrphanAndUnknownOrder_writesInOneTxAndRecomputesEachOrderOnce", async () => {
    db.order.findUnique.mockImplementation(({ where }: any) =>
      where.code === "JA1" ? { id: "o1", customerId: "c1" } : where.code === "JA2" ? { id: "o2", customerId: "c2" } : null);
    db.tracking.findFirst.mockImplementation(({ where }: any) => (where.orderId === "o1" ? { id: "empty1" } : null));
    db.tracking.update.mockResolvedValue({ id: "empty1" });
    mockClaim.mockResolvedValue({ id: "new1" });

    const r = await request(buildApp()).post("/api/trackings/bulk").send({ items: [
      { orderCode: "JA1", code: " TRK1 " }, { orderCode: "JA2", code: "TRK2" }, { orderCode: "JA9", code: "TRK9" },
    ] }).expect(200);

    expect(r.body).toEqual({ updated: 1, created: 1, notFound: ["JA9"] });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(db.tracking.update).toHaveBeenCalledWith({ where: { id: "empty1" }, data: { code: "TRK1" } });
    expect(mockClaim).toHaveBeenCalledWith("o2", "TRK2", {}, db);
    expect(mockRecompute.mock.calls.map((c) => c[0])).toEqual(["o1", "o2"]);
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c2");
  });
});

describe("PATCH /trackings/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updateTracking_codeChangedAndCartonRemoved_logsCodeChangeMarksManualAndCleansEmptyCarton", async () => {
    db.tracking.findUnique.mockResolvedValue({ cartonId: "c1", code: "OLD" });
    db.tracking.update.mockResolvedValue({ id: "t1", orderId: null, cartonId: null, code: "NEW" });
    await request(buildApp()).patch("/api/trackings/t1").send({ code: "NEW", cartonId: null }).expect(200);
    expect(db.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { code: "NEW", cartonId: null, cartonManual: true } });
    expect(db.trackingLog.create.mock.calls[0][0].data).toMatchObject({ trackingId: "t1", oldValue: { code: "OLD" }, newValue: { code: "NEW" }, reason: "Sửa mã tracking" });
    expect(deleteCartonIfEmpty).toHaveBeenCalledWith("c1");
  });
});

describe("DELETE /trackings/:id", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteTracking_hasChakubaraiCompanyCost_returns409WithClearMessage", async () => {
    db.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", cartonId: null });
    db.companyCost.count.mockResolvedValue(2);
    const r = await request(buildApp()).delete("/api/trackings/t1").expect(409);
    expect(r.body.error).toBe("TRACKING_HAS_COMPANY_COST");
    expect(r.body.message).toMatch(/chakubarai/);
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  it("deleteTracking_noCompanyCost_deletesRecomputesOrderAndRemovesSheetRow", async () => {
    db.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", cartonId: "c1" });
    db.companyCost.count.mockResolvedValue(0);
    db.order.findUnique.mockResolvedValue({ customerId: "c1" });
    await request(buildApp()).delete("/api/trackings/t1").expect(200, { ok: true });
    expect(db.tracking.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(mockRecompute).toHaveBeenCalledWith("o1", db);
    expect(queueTrackingSheetRowRemoval).toHaveBeenCalledWith("t1");
    expect(deleteCartonIfEmpty).toHaveBeenCalledWith("c1");
  });

  it("deleteTracking_unknownId_returns404", async () => {
    db.tracking.findUnique.mockResolvedValue(null);
    await request(buildApp()).delete("/api/trackings/nope").expect(404, { error: "NOT_FOUND" });
  });
});

describe("POST /trackings/:id/resolve", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolveTracking_reassignToOtherOrder_logsAndRecomputesBothOrders", async () => {
    db.tracking.findUnique.mockResolvedValue({ id: "t1", orderId: "o1", code: "TRK", status: "new" });
    db.tracking.update.mockResolvedValue({ id: "t1", orderId: "22222222-2222-2222-2222-222222222222", code: "TRK", status: "resolved" });
    db.order.findUnique.mockResolvedValue({ customerId: "c1" });
    await request(buildApp()).post("/api/trackings/t1/resolve").send({ orderId: "22222222-2222-2222-2222-222222222222", reason: "gán nhầm" }).expect(200);
    expect(db.trackingLog.create.mock.calls[0][0].data).toMatchObject({ reason: "gán nhầm", oldValue: { orderId: "o1" } });
    expect(mockRecompute.mock.calls.map((c) => c[0])).toEqual(["o1", "22222222-2222-2222-2222-222222222222"]);
  });
});
