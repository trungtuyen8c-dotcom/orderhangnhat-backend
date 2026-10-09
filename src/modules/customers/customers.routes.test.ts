import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../../app/errors/errorHandler.js";

vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "u1" }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({ authorize: () => (_req: any, _res: any, next: any) => next() }));
vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    customer: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn(), count: vi.fn() },
    order: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    debt: { groupBy: vi.fn(), count: vi.fn() },
    customerDeposit: { groupBy: vi.fn(), count: vi.fn() },
    payment: { findMany: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));
vi.mock("../sheets/customerSheetSync.service.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));

import { customersRouter } from "./customers.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { syncCustomerOrders } from "../sheets/customerSheetSync.service.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";

const mp = prisma as any;
const SHEET_URL = "https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuvwxyz123/edit";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/customers", customersRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mp.order.groupBy.mockResolvedValue([]);
  mp.debt.groupBy.mockResolvedValue([]);
  mp.customerDeposit.groupBy.mockResolvedValue([]);
  mp.payment.findMany.mockResolvedValue([]);
  mp.order.count.mockResolvedValue(0);
  mp.customerDeposit.count.mockResolvedValue(0);
  mp.debt.count.mockResolvedValue(0);
});

describe("GET /customers", () => {
  it("list_noPage_returnsPlainArrayWithRevenueDebtAndJpyDebt", async () => {
    mp.customer.findMany.mockImplementation(async (args: any) =>
      args?.select?.payCurrency ? [{ id: "c2", payCurrency: "JPY" }] : [{ id: "c1", name: "A" }, { id: "c2", name: "B" }]);
    mp.order.groupBy
      .mockResolvedValueOnce([{ customerId: "c1", _sum: { totalVnd: "1000000" } }])
      .mockResolvedValueOnce([
        { customerId: "c1", _sum: { totalVnd: "900000", dueJpy: null } },
        { customerId: "c2", _sum: { totalVnd: "0", dueJpy: "5000" } },
      ]);
    mp.debt.groupBy.mockResolvedValue([{ customerId: "c2", _sum: { balance: "999999" } }]);
    mp.customerDeposit.groupBy.mockResolvedValue([
      { customerId: "c1", currency: "VND", _sum: { amountVnd: "200000", amountOrig: "200000" } },
      { customerId: "c2", currency: "JPY", _sum: { amountVnd: "360000", amountOrig: "2000" } },
    ]);
    mp.payment.findMany.mockResolvedValue([
      { amountVnd: "100000", type: "payment", order: { customerId: "c1" } },
      { amountVnd: "50000", type: "refund", order: { customerId: "c1" } },
    ]);
    const res = await request(buildApp()).get("/api/customers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { id: "c1", name: "A", revenue: 1000000, debt: 900000 - (200000 + 100000 - 50000), debtJpy: 0 },
      { id: "c2", name: "B", revenue: 0, debt: 0, debtJpy: 3000 },
    ]);
    expect(mp.debt.groupBy).not.toHaveBeenCalled();
    expect(mp.customer.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" }, skip: undefined, take: 500 });
    expect(mp.payment.findMany.mock.calls[0][0].where).toBeUndefined();
  });

  it("list_withPage_returnsPagedEnvelopeAndScopesAggregatesToPage", async () => {
    mp.customer.findMany.mockResolvedValue([{ id: "c3", name: "C" }]);
    mp.customer.count.mockResolvedValue(51);
    const res = await request(buildApp()).get("/api/customers?page=2&pageSize=50");
    expect(res.body).toEqual({ items: [{ id: "c3", name: "C", revenue: 0, debt: 0, debtJpy: 0 }], pagination: { page: 2, pageSize: 50, total: 51, totalPages: 2 } });
    expect(mp.customer.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: "desc" }, skip: 50, take: 50 });
    expect(mp.order.groupBy.mock.calls[0][0].where).toEqual({ customerId: { in: ["c3"] } });
    expect(mp.payment.findMany.mock.calls[0][0].where).toEqual({ order: { customerId: { in: ["c3"] } } });
  });

  it("list_searchAndSort_appliesWhereToListAndCountInBothModes", async () => {
    mp.customer.findMany.mockResolvedValue([]);
    mp.customer.count.mockResolvedValue(0);
    const where = { OR: ["name", "phone", "code", "fbZalo"].map((k) => ({ [k]: { contains: "an", mode: "insensitive" } })) };

    const listCalls = () => mp.customer.findMany.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.take !== undefined);

    await request(buildApp()).get("/api/customers?q=%20an%20&sort=name").expect(200);
    expect(listCalls()[0]).toMatchObject({ where, orderBy: [{ name: "asc" }, { createdAt: "desc" }], take: 500 });

    await request(buildApp()).get("/api/customers?q=an&page=1&pageSize=20&sort=code&order=desc").expect(200);
    expect(listCalls()[1]).toMatchObject({ where, orderBy: [{ code: "desc" }, { createdAt: "desc" }], skip: 0, take: 20 });
    expect(mp.customer.count).toHaveBeenCalledWith({ where });
  });

  it("list_liteWithPage_selectsOptionFieldsWithoutAggregates", async () => {
    mp.customer.findMany.mockResolvedValue([{ id: "c1", code: "KH-0001", name: "An" }]);
    mp.customer.count.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/customers?page=1&pageSize=20&lite=1&q=an").expect(200);

    expect(res.body).toEqual({ items: [{ id: "c1", code: "KH-0001", name: "An" }], pagination: { page: 1, pageSize: 20, total: 1, totalPages: 1 } });
    expect(mp.customer.findMany.mock.calls[0][0].select).toEqual({ id: true, code: true, name: true, payCurrency: true, commissionPercentDefault: true });
    expect(mp.order.groupBy).not.toHaveBeenCalled();
    expect(mp.payment.findMany).not.toHaveBeenCalled();
  });

  it("list_invalidSort_returns400", async () => {
    await request(buildApp()).get("/api/customers?sort=debt").expect(400);
    expect(mp.customer.findMany).not.toHaveBeenCalled();
  });
});

describe("POST /customers", () => {
  it("create_invalidBody_returns400BadRequest", async () => {
    const res = await request(buildApp()).post("/api/customers").send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("create_generatesNextKhCodeAndParsesSheetId", async () => {
    mp.customer.findFirst.mockResolvedValue({ code: "KH-0041" });
    mp.customer.create.mockImplementation(async ({ data }: any) => data);
    const res = await request(buildApp()).post("/api/customers").send({ name: "A", sheetUrl: SHEET_URL });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: "KH-0042", name: "A", sheetId: "abcdefghijklmnopqrstuvwxyz123" });
    expect(res.body.sheetUrl).toBeUndefined();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "customer.created" }));
  });

  it("create_manualCodeTaken_returns409CodeTakenWithoutCreating", async () => {
    mp.customer.findFirst.mockResolvedValue({ id: "c9" });
    const res = await request(buildApp()).post("/api/customers").send({ name: "A", code: "vip-01" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("CODE_TAKEN");
    expect(mp.customer.findFirst).toHaveBeenCalledWith({ where: { code: { equals: "vip-01", mode: "insensitive" } }, select: { id: true } });
    expect(mp.customer.create).not.toHaveBeenCalled();
  });

  it("create_manualCodeFreeWithPayCurrencyAndCommission_usesGivenCode", async () => {
    mp.customer.findFirst.mockResolvedValue(null);
    mp.customer.create.mockImplementation(async ({ data }: any) => data);
    const res = await request(buildApp()).post("/api/customers").send({ name: "A", code: "VIP-01", payCurrency: "JPY", commissionPercentDefault: 5, shipRateSeaPerKg: 30000 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ code: "VIP-01", payCurrency: "JPY", commissionPercentDefault: 5, shipRateSeaPerKg: 30000 });
  });

  it("create_invalidPayCurrency_returns400", async () => {
    const res = await request(buildApp()).post("/api/customers").send({ name: "A", payCurrency: "USD" });
    expect(res.status).toBe(400);
    expect(mp.customer.create).not.toHaveBeenCalled();
  });

  it("create_noExistingCodes_startsAtKh0001", async () => {
    mp.customer.findFirst.mockResolvedValue(null);
    mp.customer.create.mockImplementation(async ({ data }: any) => data);
    const res = await request(buildApp()).post("/api/customers").send({ name: "A" });
    expect(res.body.code).toBe("KH-0001");
  });
});

describe("PATCH /customers/:id", () => {
  it("update_sheetUrlChanged_queuesCustomerSheetSync", async () => {
    mp.customer.update.mockResolvedValue({ id: "c1", sheetId: "abcdefghijklmnopqrstuvwxyz123" });
    const res = await request(buildApp()).patch("/api/customers/c1").send({ sheetUrl: SHEET_URL });
    expect(res.status).toBe(200);
    expect(mp.customer.update.mock.calls[0][0].data).toEqual({ sheetId: "abcdefghijklmnopqrstuvwxyz123" });
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("update_shipRateChanged_recomputesAllCustomerOrdersAndQueuesSync", async () => {
    mp.customer.update.mockResolvedValue({ id: "c1", sheetId: "sid" });
    mp.order.findMany.mockResolvedValue([{ id: "o1" }, { id: "o2" }]);
    await request(buildApp()).patch("/api/customers/c1").send({ shipRatePerKg: 120000 }).expect(200);
    expect(mp.order.findMany).toHaveBeenCalledWith({ where: { customerId: "c1" }, select: { id: true } });
    expect(recomputeOrderTotals).toHaveBeenCalledTimes(2);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1");
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o2");
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it.each([
    ["shipRateSeaPerKg", { shipRateSeaPerKg: 40000 }],
    ["payCurrency", { payCurrency: "JPY" }],
  ])("update_%sChanged_recomputesOrdersAndQueuesSync", async (_f, body) => {
    mp.customer.update.mockResolvedValue({ id: "c1", sheetId: "sid" });
    mp.order.findMany.mockResolvedValue([{ id: "o1" }]);
    await request(buildApp()).patch("/api/customers/c1").send(body).expect(200);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1");
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("update_onlyPhone_doesNotQueueSync", async () => {
    mp.customer.update.mockResolvedValue({ id: "c1", sheetId: "sid" });
    await request(buildApp()).patch("/api/customers/c1").send({ phone: "090" });
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
    expect(mp.order.findMany).not.toHaveBeenCalled();
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
  });

  it("update_manualCodeTakenByOtherCustomer_returns409CodeTaken", async () => {
    mp.customer.findFirst.mockResolvedValue({ id: "c2" });
    const res = await request(buildApp()).patch("/api/customers/c1").send({ code: "vip-01" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("CODE_TAKEN");
    expect(mp.customer.findFirst).toHaveBeenCalledWith({ where: { code: { equals: "vip-01", mode: "insensitive" }, id: { not: "c1" } }, select: { id: true } });
    expect(mp.customer.update).not.toHaveBeenCalled();
  });

  it("update_manualCodeFree_updatesCode", async () => {
    mp.customer.findFirst.mockResolvedValue(null);
    mp.customer.update.mockResolvedValue({ id: "c1", code: "VIP-01", sheetId: null });
    await request(buildApp()).patch("/api/customers/c1").send({ code: "VIP-01" }).expect(200);
    expect(mp.customer.update.mock.calls[0][0].data).toEqual({ code: "VIP-01" });
  });

  it("update_customerWithoutSheet_doesNotQueueSync", async () => {
    mp.customer.update.mockResolvedValue({ id: "c1", sheetId: null });
    await request(buildApp()).patch("/api/customers/c1").send({ sheetUrl: null });
    expect(mp.customer.update.mock.calls[0][0].data).toEqual({ sheetId: null });
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });
});

describe("POST /customers/:id/sync-sheet", () => {
  it("syncSheet_unknownCustomer_returns404", async () => {
    mp.customer.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post("/api/customers/x/sync-sheet");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });

  it("syncSheet_noSheet_returns400NoSheet", async () => {
    mp.customer.findUnique.mockResolvedValue({ id: "c1", sheetId: null });
    const res = await request(buildApp()).post("/api/customers/c1/sync-sheet");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "NO_SHEET", message: "Khách chưa có link Sheet" });
  });

  it("syncSheet_withSheet_runsSyncSynchronously", async () => {
    mp.customer.findUnique.mockResolvedValue({ id: "c1", sheetId: "sid" });
    const res = await request(buildApp()).post("/api/customers/c1/sync-sheet");
    expect(res.body).toEqual({ ok: true });
    expect(syncCustomerOrders).toHaveBeenCalledWith("c1");
  });
});

describe("DELETE /customers/:id", () => {
  it("delete_hasOrders_returns409HasOrders", async () => {
    mp.order.count.mockResolvedValue(2);
    const res = await request(buildApp()).delete("/api/customers/c1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "HAS_ORDERS", message: "Khách còn đơn, không xóa được" });
    expect(mp.customer.delete).not.toHaveBeenCalled();
  });

  it("delete_hasDeposits_returns409HasDeposits", async () => {
    mp.customerDeposit.count.mockResolvedValue(1);
    const res = await request(buildApp()).delete("/api/customers/c1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "HAS_DEPOSITS", message: "Khách còn lịch sử cọc, không xóa được" });
  });

  it("delete_hasDebtRows_returns409HasDebts", async () => {
    mp.debt.count.mockResolvedValue(1);
    const res = await request(buildApp()).delete("/api/customers/c1");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "HAS_DEBTS", message: "Khách còn công nợ, không xóa được" });
    expect(mp.customer.delete).not.toHaveBeenCalled();
  });

  it("delete_noReferences_deletesInTransactionAndAudits", async () => {
    const res = await request(buildApp()).delete("/api/customers/c1");
    expect(res.body).toEqual({ ok: true });
    expect(mp.$transaction).toHaveBeenCalled();
    expect(mp.customer.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "customer.deleted", targetId: "c1" }));
  });
});
