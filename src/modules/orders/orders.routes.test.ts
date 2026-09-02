import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../db.js", () => ({
  prisma: {
    order: { findUnique: vi.fn(), delete: vi.fn() },
    tracking: { deleteMany: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
let currentUser: { id: string; roles: string[] } = { id: "actor1", roles: ["staff"] };
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = currentUser; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../../utils/audit.js", () => ({ logAudit: vi.fn(), logOrder: vi.fn() }));
vi.mock("../../utils/orderTotals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../../utils/orderCard.js", () => ({ applyOrderCardCharges: vi.fn(), reverseOrderCardCharges: vi.fn() }));
vi.mock("../../utils/gsheets.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("../../utils/trackingClaim.js", () => ({ claimOrCreateTracking: vi.fn() }));

import { findWrongMarketplaceUrl, ordersRouter } from "./orders.routes.js";
import { prisma } from "../../db.js";
import { reverseOrderCardCharges } from "../../utils/orderCard.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  tracking: { deleteMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};
const mockReverseOrderCardCharges = reverseOrderCardCharges as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/orders", ordersRouter);
  return app;
}

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
  const ORDER_ID = "11111111-1111-1111-1111-111111111111";

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { id: "actor1", roles: ["staff"] };
  });

  it("ordersDelete_noPayments_deletesOrderUnlinksTrackingsAndSyncsCustomer", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [], trackings: [] });
    mockPrisma.order.delete.mockResolvedValue({});

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(200);

    expect(mockReverseOrderCardCharges).toHaveBeenCalledWith(prisma, ORDER_ID);
    expect(mockPrisma.tracking.deleteMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID, code: "" } });
    expect(mockPrisma.tracking.updateMany).toHaveBeenCalledWith({ where: { orderId: ORDER_ID }, data: { orderId: null, status: "new" } });
    expect(mockPrisma.order.delete).toHaveBeenCalledWith({ where: { id: ORDER_ID } });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it("ordersDelete_hasPaymentsNoForce_returns409HasPaymentsAndDoesNotDelete", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [{ id: "p1" }], trackings: [] });

    const res = await request(buildApp()).delete(`/api/orders/${ORDER_ID}`).expect(409);

    expect(res.body.error).toBe("HAS_PAYMENTS");
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
    const tx = {
      wallet: { update: vi.fn() },
      walletTxn: { deleteMany: vi.fn() },
      payment: { deleteMany: vi.fn() },
      debt: { deleteMany: vi.fn() },
      tracking: { deleteMany: vi.fn(), updateMany: vi.fn() },
      order: { delete: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}?force=1`).expect(200);

    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 500000 } } });
    expect(tx.order.delete).toHaveBeenCalledWith({ where: { id: ORDER_ID } });
    expect(mockPrisma.order.delete).not.toHaveBeenCalled(); // xóa qua tx, không phải prisma trực tiếp
  });

  it("ordersDelete_hasPaymentsForceAdminRoleWithRefundPayment_incrementsWalletBalanceInstead", async () => {
    currentUser = { id: "actor1", roles: ["admin"] };
    const payment = { id: "p1", walletId: "w1", type: "refund", amountOrig: "200000" };
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, customerId: "c1", payments: [payment], trackings: [] });
    const tx = {
      wallet: { update: vi.fn() },
      walletTxn: { deleteMany: vi.fn() },
      payment: { deleteMany: vi.fn() },
      debt: { deleteMany: vi.fn() },
      tracking: { deleteMany: vi.fn(), updateMany: vi.fn() },
      order: { delete: vi.fn() },
    };
    mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));

    await request(buildApp()).delete(`/api/orders/${ORDER_ID}?force=1`).expect(200);

    // refund đảo dấu: xóa 1 khoản refund phải TRỪ NGƯỢC lại (cộng tiền vào ví) - decrement âm = tăng số dư.
    expect(tx.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: -200000 } } });
  });
});
