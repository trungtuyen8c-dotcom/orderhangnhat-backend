import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../../app/errors/errorHandler.js";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    tracking: { findMany: vi.fn() },
    orderItem: { findMany: vi.fn() },
    invoice: { findMany: vi.fn(), count: vi.fn(), findUnique: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "actor1", roles: ["staff"] }; next(); },
}));
const authorizeCalls: string[][] = [];
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: (...p: string[]) => { authorizeCalls.push(p); return (_req: any, _res: any, next: any) => next(); },
}));

const { invoicesRouter } = await import("./invoice.routes.js");
const { prisma } = await import("../../infrastructure/prisma.js");
const db = prisma as any;

function buildApp() {
  const app = express();
  app.use("/api/invoices", invoicesRouter);
  app.use(errorHandler);
  return app;
}

const ID = "33333333-3333-4333-8333-333333333333";

describe("invoicesRouter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes_allGuardedByTrackingsList", () => {
    expect(authorizeCalls.length).toBe(3);
    expect(authorizeCalls.every((p) => p.length === 1 && p[0] === "trackings.list")).toBe(true);
  });

  it("pending_givenNoMonth_then400", async () => {
    const r = await request(buildApp()).get("/api/invoices/pending").expect(400);
    expect(r.body.error).toBe("BAD_REQUEST");
  });

  it("pending_givenMonthPage_thenPagedWithTotalsOverWholeFilter", async () => {
    db.tracking.findMany
      .mockResolvedValueOnce([{
        id: "t1", code: "X1", status: "linked", packedAt: null, jpName: null, createdAt: new Date(),
        order: { id: "o1", code: "JA1", orderDate: new Date("2026-06-01T00:00:00Z"), status: "purchased", customer: { name: "A" }, items: [{ name: "Ao", qty: 1, unitPriceJpy: "100" }] },
      }])
      .mockResolvedValueOnce([{ orderId: "o1", packedAt: null }, { orderId: "o2", packedAt: new Date() }]);
    db.orderItem.findMany.mockResolvedValue([{ qty: 1, unitPriceJpy: "100" }, { qty: 2, unitPriceJpy: "50" }]);
    const r = await request(buildApp()).get("/api/invoices/pending?month=2026-06&page=2&pageSize=1&unpacked=1&q=%20JA%20").expect(200);
    expect(r.body.pagination).toEqual({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(r.body.totals).toEqual({ trackings: 2, orders: 2, unpacked: 1, amountJpy: 200 });
    expect(r.body.items[0]).toMatchObject({ trackingId: "t1", orderCode: "JA1", amountJpy: 100 });
    const pageArg = db.tracking.findMany.mock.calls[0][0];
    expect(pageArg).toMatchObject({ skip: 1, take: 1 });
    expect(pageArg.where.packedAt).toBeNull();
    expect(pageArg.where.AND[0].OR[0].code.contains).toBe("JA");
    expect(db.orderItem.findMany.mock.calls[0][0].where).toEqual({ orderId: { in: ["o1", "o2"] } });
  });

  it("pending_givenNothing_thenNoOrderItemQuery", async () => {
    db.tracking.findMany.mockResolvedValue([]);
    const r = await request(buildApp()).get("/api/invoices/pending?month=2026-06").expect(200);
    expect(r.body.pagination).toMatchObject({ page: 1, pageSize: 50, total: 0 });
    expect(db.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("history_givenRows_thenCreatorNameResolved", async () => {
    db.invoice.findMany.mockResolvedValue([{ id: ID, createdAt: new Date("2026-06-05T00:00:00Z"), createdBy: "u1", note: "GB-1", trackingCount: 2, lineCount: 3, totalJpy: "2800" }]);
    db.invoice.count.mockResolvedValue(1);
    db.user.findMany.mockResolvedValue([{ id: "u1", fullName: null, email: "kho@x" }]);
    const r = await request(buildApp()).get("/api/invoices").expect(200);
    expect(r.body.items).toEqual([{ id: ID, createdAt: "2026-06-05T00:00:00.000Z", createdBy: "u1", createdByName: "kho@x", note: "GB-1", trackingCount: 2, lineCount: 3, totalJpy: 2800 }]);
  });

  it("detail_givenBadId_then400_givenMissing_then404", async () => {
    await request(buildApp()).get("/api/invoices/abc").expect(400);
    db.invoice.findUnique.mockResolvedValue(null);
    await request(buildApp()).get(`/api/invoices/${ID}`).expect(404);
  });

  it("detail_givenItems_thenSnapshotAndCurrentCode", async () => {
    db.invoice.findUnique.mockResolvedValue({
      id: ID, createdAt: new Date("2026-06-05T00:00:00Z"), createdBy: null, note: null, trackingCount: 1, lineCount: 1, totalJpy: "100",
      items: [{ id: "i1", trackingId: null, trackingCode: "OLD", orderId: "o1", orderCode: "JA1", customerName: "A", tracking: null }],
    });
    const r = await request(buildApp()).get(`/api/invoices/${ID}`).expect(200);
    expect(r.body.items).toEqual([{ id: "i1", trackingId: null, trackingCode: "OLD", currentTrackingCode: null, orderId: "o1", orderCode: "JA1", customerName: "A" }]);
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
