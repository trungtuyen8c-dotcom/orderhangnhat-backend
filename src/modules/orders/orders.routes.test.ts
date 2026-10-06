import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    order: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), delete: vi.fn() },
    orderItem: { deleteMany: vi.fn(), updateMany: vi.fn() },
    tracking: { create: vi.fn(), update: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    companyCost: { findMany: vi.fn() },
    walletTxn: { updateMany: vi.fn(), deleteMany: vi.fn() },
    wallet: { findUnique: vi.fn(), update: vi.fn() },
    payment: { deleteMany: vi.fn() },
    debt: { deleteMany: vi.fn() },
    expense: { updateMany: vi.fn() },
    weightRecon: { deleteMany: vi.fn() },
    customer: { findUnique: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma: p };
});
let currentUser: { id: string; roles: string[] } = { id: "actor1", roles: ["staff"] };
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = currentUser; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn(), logOrder: vi.fn() }));
vi.mock("./order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../accounting/orderCard.js", () => ({ applyOrderCardCharges: vi.fn(), reverseOrderCardCharges: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));
vi.mock("../tracking/tracking.repository.js", () => ({ claimOrCreateTracking: vi.fn() }));

import { findWrongMarketplaceUrl, ordersRouter } from "./orders.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { applyOrderCardCharges, reverseOrderCardCharges } from "../accounting/orderCard.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { recomputeOrderTotals } from "./order.totals.js";
import { claimOrCreateTracking } from "../tracking/tracking.repository.js";
import { logOrder } from "../../app/audit.js";

const mockPrisma = prisma as any;
const mockReverseOrderCardCharges = reverseOrderCardCharges as ReturnType<typeof vi.fn>;
const mockApplyOrderCardCharges = applyOrderCardCharges as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/orders", ordersRouter);
  return app;
}

const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "22222222-2222-2222-2222-222222222222";
const WALLET_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: "actor1", roles: ["staff"] };
  // Mặc định transaction chạy callback trên chính mock prisma
  mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockPrisma));
  mockPrisma.companyCost.findMany.mockResolvedValue([]);
});

describe("findWrongMarketplaceUrl", () => {
  it("findWrongMarketplaceUrl_sourceNotYahooOrMercari_returnsNull", () => {
    const items = [{ url: "https://www.mercari.com/item/1" }];
    expect(findWrongMarketplaceUrl("other", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_yahooSourceWithMercariItemUrl_returnsThatUrl", () => {
    const items = [{ url: "https://www.mercari.com/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBe("https://www.mercari.com/item/1");
  });

  it("findWrongMarketplaceUrl_yahooSourceWithMatchingYahooUrls_returnsNull", () => {
    const items = [{ url: "https://page.auctions.yahoo.co.jp/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_itemUrlNotFromEitherMarketplace_returnsNull", () => {
    const items = [{ url: "https://example.com/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_itemMissingUrl_skipsItem", () => {
    const items = [{}, { url: "https://page.auctions.yahoo.co.jp/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });
});

describe("DELETE /orders/:id", () => {
  function forceTx() {
    return {
      wallet: { update: vi.fn() },
      walletTxn: { deleteMany: vi.fn(), updateMany: vi.fn() },
      payment: { deleteMany: vi.fn() },
      debt: { deleteMany: vi.fn() },
      expense: { updateMany: vi.fn() },
      weightRecon: { deleteMany: vi.fn() },
      tracking: { deleteMany: vi.fn(), updateMany: vi.fn() },
      order: { delete: vi.fn() },
    };
  }

  it("ordersDelete_noPayments_deletesOrderUnlinksTrackingsAndSyncsCustomerInOneTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [], trackings: [] });
    mockPrisma.order.delete.mockResolvedValue({});

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(200, { ok: true });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    // tx = mockPrisma (mặc định của mock $transaction)
    expect(mockReverseOrderCardCharges).toHaveBeenCalledWith(mockPrisma, ORDER_ID);
    expect(mockPrisma.tracking.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID, code: "", companyCosts: { none: {} } } });
    expect(mockPrisma.tracking.updateMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID }, data: { orderId: null, status: "new" } });
    expect(mockPrisma.order.delete).toHaveBeenCalledWith({ where: { id: ORDER_ID } });
    expect(queueCustomerSheetSync).toHaveBeenCalledWith("c1");
  });

  it("ordersDelete_noPaymentsButDebtRowExists_deletesDebtBeforeOrderSoFkRestrictDoesNotFail", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [], trackings: [] });
    const calls: string[] = [];
    mockPrisma.debt.deleteMany.mockImplementation(async () => { calls.push("debt"); });
    mockPrisma.order.delete.mockImplementation(async () => { calls.push("order"); });

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(200);

    expect(mockPrisma.debt.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID } });
    expect(calls).toEqual(["debt", "order"]);
  });

  it("ordersDelete_noPayments_keepsManualWalletTxnsAndExpensesButUnlinksThem_deletesWeightRecon", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [], trackings: [] });

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(200);

    expect(mockPrisma.walletTxn.updateMany).toHaveBeenCalledWith({ where: { refOrderId: ORDER_ID }, data: { refOrderId: null } });
    expect(mockPrisma.walletTxn.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.expense.updateMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID }, data: { orderId: null } });
    expect(mockPrisma.weightRecon.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID } });
  });

  it("ordersDelete_transactionFails_returnsErrorAndDoesNotSyncSheet", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [], trackings: [] });
    mockPrisma.$transaction.mockRejectedValue(new Error("db down"));
    const app = buildApp();
    app.use((_e: any, _req: any, res: any, _next: any) => res.status(500).json({ error: "INTERNAL" }));

    await request(app).delete(`/api/orders/${ORDER_ID}`).expect(500);

    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("ordersDelete_notFound_returns404", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });

  it("ordersDelete_hasPaymentsNoForce_returns409HasPaymentsAndDoesNotDelete", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [{ id: "p1" }], trackings: [] });

    const res = await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(409);

    expect(res.body).toEqual({ error: "HAS_PAYMENTS", message: "Đơn đã có giao dịch, không xóa được" });
    expect(mockPrisma.order.delete).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("ordersDelete_hasPaymentsForceNonAdminRole_returns403ForbiddenAndDoesNotDelete", async () => {
    currentUser = { id: "actor1", roles: ["sale"] };
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [{ id: "p1" }], trackings: [] });

    const res = await request(buildApp()).delete(`/api/orders/${ORDER_ID}?force=1`).expect(403);

    expect(res.body.error).toBe("FORBIDDEN");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("ordersDelete_hasPaymentsForceAdminRole_reversesWalletBalanceAndDeletesViaTransaction", async () => {
    currentUser = { id: "actor1", roles: ["admin"] };
    const payment = { id: "p1", walletId: "w1", type: "deposit", amountOrig: "500000" };
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [payment], trackings: [] });
    const tx = forceTx();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}?force=1`).expect(200);

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 500000 } } });
    expect(mockReverseOrderCardCharges).toHaveBeenCalledWith(tx, ORDER_ID);
    expect(tx.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refOrderId: ORDER_ID, type: { in: ["deposit", "final", "refund"] } } });
    expect(tx.payment.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID } });
    expect(tx.debt.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID } });
    expect(tx.order.delete).toHaveBeenCalledWith({ where: { id: ORDER_ID } });
    expect(mockPrisma.order.delete).not.toHaveBeenCalled(); // xóa qua tx, không phải prisma trực tiếp
  });

  it("ordersDelete_hasPaymentsForceAdminRoleWithRefundPayment_incrementsWalletBalanceInstead", async () => {
    currentUser = { id: "actor1", roles: ["admin"] };
    const payment = { id: "p1", walletId: "w1", type: "refund", amountOrig: "200000" };
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [payment], trackings: [] });
    const tx = forceTx();
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}?force=1`).expect(200);

    // refund đảo dấu: xóa 1 khoản refund phải TRỪ NGƯỢC lại (cộng tiền vào ví) - decrement âm = tăng số dư.
    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 200000 } } });
  });
});

describe("GET /orders", () => {
  it("ordersList_noPage_returnsPlainArrayLikeBefore", async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o1" }]);

    const res = await request(buildApp()).get("/api/orders?exclude=yahoo,mercari").expect(200);

    expect(res.body).toEqual([{ id: "o1" }]);
    const args = mockPrisma.order.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ source: { notIn: ["yahoo", "mercari"] } });
    expect(args.skip).toBeUndefined();
    expect(mockPrisma.order.count).not.toHaveBeenCalled();
  });

  it("ordersList_payLaterSource_filtersBySourceAndSelectsItemPrices", async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);

    await request(buildApp()).get("/api/orders?source=yahoo").expect(200);

    const args = mockPrisma.order.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ source: "yahoo" });
    expect(args.include.items.select).toHaveProperty("unitPriceJpy", true);
  });

  it("ordersList_withPage_returnsItemsAndPaginationUsingSameWhere", async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o3" }]);
    mockPrisma.order.count.mockResolvedValue(7);

    const res = await request(buildApp()).get("/api/orders?page=2&pageSize=3").expect(200);

    expect(res.body).toEqual({ items: [{ id: "o3" }], pagination: { page: 2, pageSize: 3, total: 7, totalPages: 3 } });
    const args = mockPrisma.order.findMany.mock.calls[0][0];
    expect(args.skip).toBe(3);
    expect(args.take).toBe(3);
    expect(mockPrisma.order.count).toHaveBeenCalledWith({ where: undefined });
  });
});

describe("PATCH /orders/:id/status", () => {
  it("ordersStatus_invalidStatusValue_returns400BadRequest", async () => {
    const res = await request(buildApp()).patch(`/api/orders/${ORDER_ID}/status`).send({ status: "shipped" }).expect(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("ordersStatus_backwardsManualChange_allowedAndLogged", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, status: "delivered" });
    mockPrisma.order.update.mockResolvedValue({ id: ORDER_ID, status: "quoted" });

    const res = await request(buildApp()).patch(`/api/orders/${ORDER_ID}/status`).send({ status: "quoted" }).expect(200);

    expect(res.body).toEqual({ id: ORDER_ID, status: "quoted" });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: ORDER_ID }, data: { status: "quoted" } });
    expect(logOrder).toHaveBeenCalledWith(expect.objectContaining({ action: "status_changed", changes: [{ field: "status", old: "delivered", new: "quoted" }] }));
  });

  it("ordersStatus_orderMissing_returns404", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await request(buildApp()).patch(`/api/orders/${ORDER_ID}/status`).send({ status: "quoted" }).expect(404, { error: "NOT_FOUND" });
  });
});

describe("PATCH /orders/:id", () => {
  const baseOrder = {
    id: ORDER_ID, code: "JA10001", customerId: CUSTOMER_ID, status: "quoted", source: "normal", yahooPaidAt: null,
    orderDate: new Date("2026-09-01"), exchangeRate: 180, items: [], totalVnd: null,
    trackings: [{ id: "t-keep", code: "KEEP" }, { id: "t-cod", code: "COD1" }],
  };

  it("ordersEdit_lockedStatus_returns409Locked", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...baseOrder, status: "deposited" });
    const res = await request(buildApp()).patch(`/api/orders/${ORDER_ID}`).send({ nick: "x" }).expect(409);
    expect(res.body).toEqual({ error: "LOCKED", message: "Chỉ sửa được đơn ở trạng thái nháp/đã báo giá" });
  });

  it("ordersEdit_removesTrackingThatHasCompanyCost_returns409WithClearMessageAndWritesNothing", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder);
    mockPrisma.companyCost.findMany.mockResolvedValue([{ refId: "t-cod", kind: "chakubarai" }]);

    const res = await request(buildApp()).patch(`/api/orders/${ORDER_ID}`)
      .send({ trackings: [{ id: "11111111-2222-3333-4444-555555555555", code: "KEEP" }] }).expect(409);

    expect(res.body.error).toBe("TRACKING_HAS_COST");
    expect(res.body.message).toContain("COD1");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.tracking.deleteMany).not.toHaveBeenCalled();
  });

  it("ordersEdit_newItems_replacesItemsAndRechargesCardInsideTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce({ ...baseOrder, trackings: [] }).mockResolvedValueOnce({ id: ORDER_ID });
    (recomputeOrderTotals as any).mockResolvedValue({ totalQuote: 100, totalVnd: 18000 });
    const items = [{ name: "A", qty: 1, unitPriceJpy: 100, paymentMethod: "Card" }];

    await request(buildApp()).patch(`/api/orders/${ORDER_ID}`).send({ items }).expect(200, { id: ORDER_ID });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID } });
    expect(mockReverseOrderCardCharges).toHaveBeenCalledWith(mockPrisma, ORDER_ID);
    expect(mockApplyOrderCardCharges).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ orderId: ORDER_ID, code: "JA10001" }));
    expect(queueCustomerSheetSync).toHaveBeenCalledWith(CUSTOMER_ID);
  });

  it("ordersEdit_newTrackingWithoutId_claimedInsideSameTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValueOnce({ ...baseOrder, trackings: [] }).mockResolvedValueOnce({ id: ORDER_ID });

    await request(buildApp()).patch(`/api/orders/${ORDER_ID}`).send({ trackings: [{ code: "NEW1" }] }).expect(200);

    expect(claimOrCreateTracking).toHaveBeenCalledWith(ORDER_ID, "NEW1", { jpWeightKg: undefined, unitPriceVndPerKg: undefined }, mockPrisma);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /orders", () => {
  it("ordersCreate_normalSource_createsOrderAndChargesCardInSameTransaction", async () => {
    mockPrisma.customer.findUnique.mockResolvedValue({ skipVnWeighingDefault: true });
    mockPrisma.order.findFirst.mockResolvedValue({ code: "JA10041" });
    mockPrisma.order.create.mockImplementation(async ({ data }: any) => ({ ...data, items: undefined }));
    (recomputeOrderTotals as any).mockResolvedValue({ totalQuote: 1000, totalVnd: 180000 });

    const res = await request(buildApp()).post("/api/orders")
      .send({ customerId: CUSTOMER_ID, items: [{ name: "A", unitPriceJpy: 1000, paymentMethod: "Card" }], exchangeRate: 180 }).expect(201);

    expect(res.body.code).toBe("JA10042");
    expect(res.body.status).toBe("quoted");
    expect(res.body.skipVnWeighing).toBe(true);
    expect(res.body.totalVnd).toBe(180000);
    expect(mockApplyOrderCardCharges).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ code: "JA10042" }));
    expect(recomputeOrderTotals).toHaveBeenCalledWith(expect.any(String), mockPrisma);
    // không có tracking -> tạo placeholder trống trong cùng transaction
    expect(mockPrisma.tracking.create).toHaveBeenCalledWith({ data: expect.objectContaining({ code: "", status: "linked" }) });
  });

  it("ordersCreate_yahooSource_doesNotChargeCard", async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    mockPrisma.order.create.mockImplementation(async ({ data }: any) => data);

    await request(buildApp()).post("/api/orders")
      .send({ customerId: CUSTOMER_ID, source: "yahoo", skipVnWeighing: false, items: [{ name: "A", unitPriceJpy: 1000 }] }).expect(201);

    expect(mockApplyOrderCardCharges).not.toHaveBeenCalled();
  });

  it("ordersCreate_duplicateCodeRace_retriesWholeTransaction", async () => {
    mockPrisma.order.findFirst.mockResolvedValue(null);
    mockPrisma.order.create
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }))
      .mockImplementation(async ({ data }: any) => data);

    await request(buildApp()).post("/api/orders")
      .send({ customerId: CUSTOMER_ID, skipVnWeighing: false, items: [{ name: "A", unitPriceJpy: 1 }] }).expect(201);

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it("ordersCreate_wrongMarketplaceLink_returns400", async () => {
    const res = await request(buildApp()).post("/api/orders")
      .send({ customerId: CUSTOMER_ID, source: "yahoo", items: [{ name: "A", unitPriceJpy: 1, url: "https://jp.mercari.com/item/m1" }] }).expect(400);
    expect(res.body.error).toBe("WRONG_MARKETPLACE");
  });

  it("ordersCreate_invalidBody_returns400BadRequest", async () => {
    await request(buildApp()).post("/api/orders").send({ items: [] }).expect(400, { error: "BAD_REQUEST" });
  });
});

describe("POST /orders/consignment", () => {
  it("ordersConsignment_jpyRateWithoutExchangeRate_returns400WithMessage", async () => {
    const res = await request(buildApp()).post("/api/orders/consignment")
      .send({ customerId: CUSTOMER_ID, code: "C1", shipRateCurrency: "JPY" }).expect(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST", message: "Đơn giá JPY/kg cần nhập tỉ giá" });
  });

  it("ordersConsignment_ok_createsVnWarehouseOrderAndClaimsTrackingInTransaction", async () => {
    mockPrisma.order.findFirst.mockResolvedValue({ code: "JA10005" });
    mockPrisma.order.create.mockImplementation(async ({ data }: any) => data);

    const res = await request(buildApp()).post("/api/orders/consignment")
      .send({ customerId: CUSTOMER_ID, code: " C1 ", jpWeightKg: 2 }).expect(201);

    expect(res.body.status).toBe("vn_warehouse");
    expect(res.body.code).toBe("JA10006");
    expect(claimOrCreateTracking).toHaveBeenCalledWith(expect.any(String), " C1 ", expect.objectContaining({ jpWeightKg: 2, shipRateCurrency: "VND" }), mockPrisma);
  });
});

describe("POST /orders/:id/pay", () => {
  const order = { id: ORDER_ID, code: "JA1", source: "yahoo", yahooPaidAt: null, exchangeRate: 180, orderDate: new Date("2026-09-01"), items: [{ unitPriceJpy: 100, qty: 1, shipJpy: null, purchaseDate: null }] };

  it("ordersPay_concurrentAlreadyClaimed_returns409AlreadyPaidAndDoesNotCharge", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order);
    mockPrisma.wallet.findUnique.mockResolvedValue({ id: WALLET_ID, name: "Card" });
    mockPrisma.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/pay`).send({ walletId: WALLET_ID }).expect(409);

    expect(res.body).toEqual({ error: "ALREADY_PAID", message: "Đơn đã thanh toán" });
    expect(mockApplyOrderCardCharges).not.toHaveBeenCalled();
  });

  it("ordersPay_ok_setsPaidAtAssignsCardAndChargesInOneTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(order);
    mockPrisma.wallet.findUnique.mockResolvedValue({ id: WALLET_ID, name: "Card" });
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/pay`).send({ walletId: WALLET_ID }).expect(200, { ok: true });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.orderItem.updateMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID }, data: { paymentMethod: "Card" } });
    expect(mockApplyOrderCardCharges).toHaveBeenCalledWith(mockPrisma, expect.objectContaining({ fallbackDate: order.orderDate }));
  });

  it("ordersPay_notPayLaterSource_returns409NotYahoo", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ ...order, source: "normal" });
    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/pay`).send({ walletId: WALLET_ID }).expect(409);
    expect(res.body.error).toBe("NOT_YAHOO");
  });
});

describe("POST /orders/:id/unpay", () => {
  it("ordersUnpay_paid_clearsPaidAtAndRefundsCardInTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, source: "mercari", yahooPaidAt: new Date() });
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/unpay`).expect(200, { ok: true });

    expect(mockReverseOrderCardCharges).toHaveBeenCalledWith(mockPrisma, ORDER_ID);
  });

  it("ordersUnpay_notPaid_returns409NotPaid", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, source: "mercari", yahooPaidAt: null });
    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/unpay`).expect(409);
    expect(res.body).toEqual({ error: "NOT_PAID", message: "Đơn chưa thanh toán" });
  });
});

describe("POST /orders/:id/request-fix", () => {
  it("ordersRequestFix_emptyNote_returns400WithMessage", async () => {
    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/request-fix`).send({ note: "" }).expect(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST", message: "Nhập nội dung yêu cầu sửa" });
  });
});
