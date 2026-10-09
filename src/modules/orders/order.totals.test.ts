import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    order: { findUnique: vi.fn(), update: vi.fn() },
    companyCost: { findMany: vi.fn() },
    debt: { findFirst: vi.fn(), update: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});

import { trackingShipVnd, computeDebtBalance, recomputeOrderTotals, orderCharges, customerShipRate } from "./order.totals.js";
import { prisma } from "../../infrastructure/prisma.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  companyCost: { findMany: ReturnType<typeof vi.fn> };
  debt: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};

describe("trackingShipVnd", () => {
  it("trackingShipVnd_vnWeightPresent_usesVnWeight", () => {
    const t = { jpWeightKg: "6", vnWeightKg: "5", unitPriceVndPerKg: "1000" };
    expect(trackingShipVnd(t)).toBe(5000);
  });

  it("trackingShipVnd_vnWeightNullJpWeightPresent_usesJpWeight", () => {
    const t = { jpWeightKg: "6", vnWeightKg: null, unitPriceVndPerKg: "1000" };
    expect(trackingShipVnd(t)).toBe(6000);
  });

  it("trackingShipVnd_vndRateCurrency_multipliesKgByPriceDirectly", () => {
    const t = { jpWeightKg: "2", vnWeightKg: null, unitPriceVndPerKg: "50000", shipRateCurrency: "VND" };
    expect(trackingShipVnd(t, 180)).toBe(100000);
  });

  it("trackingShipVnd_jpyRateCurrencyWithExchangeRate_convertsPriceByRate", () => {
    const t = { jpWeightKg: "2", vnWeightKg: null, unitPriceVndPerKg: "300", shipRateCurrency: "JPY" };
    expect(trackingShipVnd(t, 180)).toBe(108000);
  });

  it("trackingShipVnd_jpyRateCurrencyNoRateProvided_returnsZero", () => {
    const t = { jpWeightKg: "2", vnWeightKg: null, unitPriceVndPerKg: "300", shipRateCurrency: "JPY" };
    expect(trackingShipVnd(t)).toBe(0);
  });
});

describe("computeDebtBalance", () => {
  it("computeDebtBalance_orderHasTotalVnd_returnsVndBalanceAfterPayments", () => {
    const order = { totalVnd: "1000000", totalQuote: "0" };
    const payments = [
      { type: "deposit", amountVnd: "300000", currency: "VND", amountOrig: "300000" },
      { type: "final", amountVnd: "200000", currency: "VND", amountOrig: "200000" },
    ];
    const { balance, currency } = computeDebtBalance(order, payments);
    expect(balance).toBe(500000);
    expect(currency).toBe("VND");
  });

  it("computeDebtBalance_orderHasTotalVndWithRefund_addsRefundBackToBalance", () => {
    const order = { totalVnd: "1000000", totalQuote: "0" };
    const payments = [
      { type: "deposit", amountVnd: "1000000", currency: "VND", amountOrig: "1000000" },
      { type: "refund", amountVnd: "200000", currency: "VND", amountOrig: "200000" },
    ];
    const { balance } = computeDebtBalance(order, payments);
    expect(balance).toBe(200000);
  });

  it("computeDebtBalance_orderNoTotalVnd_returnsJpyBalanceFromQuoteMinusJpyPayments", () => {
    const order = { totalVnd: null, totalQuote: "10000" };
    const payments = [{ type: "deposit", amountVnd: "0", currency: "JPY", amountOrig: "4000" }];
    const { balance, currency } = computeDebtBalance(order, payments);
    expect(balance).toBe(6000);
    expect(currency).toBe("JPY");
  });

  it("computeDebtBalance_orderNoTotalVndNonJpyPaymentsIgnored_returnsFullQuoteAsBalance", () => {
    const order = { totalVnd: null, totalQuote: "10000" };
    const payments = [{ type: "deposit", amountVnd: "1000000", currency: "VND", amountOrig: "1000000" }];
    const { balance } = computeDebtBalance(order, payments);
    expect(balance).toBe(10000);
  });

  it("computeDebtBalance_orderNoTotalVndWithJpyRefund_addsRefundBackToJpyBalance", () => {
    const order = { totalVnd: null, totalQuote: "10000" };
    const payments = [
      { type: "deposit", amountVnd: "0", currency: "JPY", amountOrig: "10000" },
      { type: "refund", amountVnd: "0", currency: "JPY", amountOrig: "3000" },
    ];
    const { balance } = computeDebtBalance(order, payments);
    expect(balance).toBe(3000);
  });
});

function baseOrder(overrides: Record<string, unknown> = {}) {
  return {
    items: [], trackings: [], payments: [], customer: null,
    exchangeRate: null,
    shipAmount: null, shipCurrency: null,
    surchargeAmount: null, surchargeCurrency: null,
    serviceFeeAmount: null, serviceFeeCurrency: null,
    jpDomesticShipAmount: null, jpDomesticShipCurrency: null,
    intlShipAmount: null, intlShipCurrency: null,
    discountAmount: null, discountCurrency: null,
    ...overrides,
  };
}

describe("recomputeOrderTotals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.companyCost.findMany.mockResolvedValue([]);
    mockPrisma.debt.findFirst.mockResolvedValue(null);
  });

  it("recomputeOrderTotals_orderNotFound_returnsUndefinedAndDoesNotUpdate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    const result = await recomputeOrderTotals("missing-order");
    expect(result).toBeUndefined();
    expect(mockPrisma.order.update).not.toHaveBeenCalled();
  });

  it("recomputeOrderTotals_jpyItemsWithRateAndNoFees_updatesTotalQuoteAndTotalVnd", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{ qty: 2, unitPriceJpy: "1000", shipJpy: null }],
      exchangeRate: "180",
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 2000, totalVnd: 360000, dueJpy: null });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { totalQuote: 2000, totalVnd: 360000, dueJpy: null } });
  });

  it("recomputeOrderTotals_jpyItemsNoRate_setsTotalVndNull", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{ qty: 1, unitPriceJpy: "500", shipJpy: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 500, totalVnd: null, dueJpy: null });
  });

  it("recomputeOrderTotals_trackingNeedsRateButNoRate_setsTotalVndNull", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      trackings: [{ id: "t1", unitPriceVndPerKg: "300", shipRateCurrency: "JPY", jpWeightKg: "2", vnWeightKg: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result?.totalVnd).toBeNull();
    expect(mockPrisma.companyCost.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { kind: "chakubarai", refId: { in: ["t1"] } } }));
  });

  it("recomputeOrderTotals_customerDefaultShipRateUsedWhenTrackingRateMissing_includesShipInTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      customer: { shipRatePerKg: "50000" },
      trackings: [{ id: "t1", unitPriceVndPerKg: null, shipRateCurrency: "VND", jpWeightKg: "2", vnWeightKg: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 100000, dueJpy: null });
  });

  // Regression: tracking để lại shipRateCurrency="JPY" từ trước (chưa từng set unitPriceVndPerKg riêng) rồi
  // fallback sang giá mặc định khách (luôn VND) - trước fix, cờ JPY cũ bị giữ nguyên khiến trackingShipVnd
  // nhân nhầm thêm 1 lần tỉ giá (2kg x 50.000đ = 100.000đ bị tính sai thành 18.000.000đ, gấp đúng tỉ giá 180).
  it("recomputeOrderTotals_customerDefaultShipRateWithStaleJpyCurrencyFlag_doesNotDoubleConvertByRate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      customer: { shipRatePerKg: "50000" },
      trackings: [{ id: "t1", unitPriceVndPerKg: null, shipRateCurrency: "JPY", jpWeightKg: "2", vnWeightKg: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 100000, dueJpy: null });
  });

  it("recomputeOrderTotals_companyCostChakubaraiRows_addsCodVndToTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      trackings: [{ id: "t1", unitPriceVndPerKg: "0", shipRateCurrency: "VND", jpWeightKg: "0", vnWeightKg: null }],
    }));
    mockPrisma.companyCost.findMany.mockResolvedValue([{ currency: "VND", amountOrig: "250000", amountVnd: "250000", exchangeRate: null }]);
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 250000, dueJpy: null });
  });

  it("recomputeOrderTotals_existingDebtRow_recomputesDebtBalance", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{ qty: 2, unitPriceJpy: "1000", shipJpy: null }],
      exchangeRate: "180",
    }));
    mockPrisma.debt.findFirst.mockResolvedValue({ id: "d1" });
    await recomputeOrderTotals("o1");
    expect(mockPrisma.debt.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { balance: 360000, currency: "VND" } });
  });

  it("recomputeOrderTotals_jpyPayCustomerWithDebtRow_debtInJpyFromDueJpyMinusJpyPayments", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      customer: { shipRatePerKg: "50000", payCurrency: "JPY" },
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      payments: [
        { type: "deposit", currency: "JPY", amountOrig: "4000", amountVnd: "680000" },
        { type: "deposit", currency: "VND", amountOrig: "50000", amountVnd: "50000" },
      ],
    }));
    mockPrisma.debt.findFirst.mockResolvedValue({ id: "d1" });
    await recomputeOrderTotals("o1");
    expect(mockPrisma.debt.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { balance: 6000, currency: "JPY" } });
  });

  it("recomputeOrderTotals_noExistingDebtRow_doesNotUpdateDebt", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{ qty: 2, unitPriceJpy: "1000", shipJpy: null }],
      exchangeRate: "180",
    }));
    await recomputeOrderTotals("o1");
    expect(mockPrisma.debt.update).not.toHaveBeenCalled();
  });

  it("recomputeOrderTotals_allFeesInVndCurrencyNoRate_sumsFeesWithoutNeedingExchangeRate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      shipAmount: "50000", shipCurrency: "VND",
      surchargeAmount: "10000", surchargeCurrency: "VND",
      discountAmount: "5000", discountCurrency: "VND",
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 55000, dueJpy: null });
  });

  it("recomputeOrderTotals_discountAmountJpyWithRate_subtractsConvertedDiscountFromTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      discountAmount: "1000", discountCurrency: "JPY",
    }));
    const result = await recomputeOrderTotals("o1");
    // subtotalJpy(10000)*180 - discount(1000)*180 = 1800000 - 180000 = 1620000
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 1620000, dueJpy: null });
  });

  // Công % cộng vào tiền khách: Công = (hàng + ship món - giảm ¥) x %, quy theo tỉ giá.
  it("recomputeOrderTotals_commissionPercentSet_addsCommissionToTotalVnd", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      commissionPercent: "10",
    }));
    const result = await recomputeOrderTotals("o1");
    // (10000 + công 1000) * 180 = 1980000; totalQuote vẫn là tiền hàng.
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 1980000, dueJpy: null });
  });

  it("recomputeOrderTotals_commissionPercentWithOrderShipFee_commissionOnItemsOnlyNotOnShip", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      commissionPercent: "10",
      shipAmount: "5000", shipCurrency: "JPY",
    }));
    const result = await recomputeOrderTotals("o1");
    // (10000 + công 1000 + ship 5000) * 180 = 2880000 (công không tính trên ship đơn)
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 2880000, dueJpy: null });
  });

  it("recomputeOrderTotals_commissionWithJpyDiscount_commissionOnItemsMinusDiscount", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "200",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: "1000" }],
      discountAmount: "1000", discountCurrency: "JPY",
      commissionPercent: "10",
    }));
    const result = await recomputeOrderTotals("o1");
    // Tổng = 10000 + 1000 - 1000 = 10000; công 1000 -> 11000 * 200
    expect(result).toEqual({ totalQuote: 11000, totalVnd: 2200000, dueJpy: null });
  });

  it("recomputeOrderTotals_couponAmountSet_doesNotReduceCustomerTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      couponAmount: "2000", couponCurrency: "JPY",
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 1800000, dueJpy: null });
  });

  it("recomputeOrderTotals_serviceFeeCustomerPaysFalse_excludesServiceFee", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "1000", shipJpy: null }],
      serviceFeeAmount: "500", serviceFeeCurrency: "JPY", serviceFeeCustomerPays: false,
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 1000, totalVnd: 180000, dueJpy: null });
  });

  it("recomputeOrderTotals_serviceFeeCustomerPaysTrue_includesServiceFee", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "1000", shipJpy: null }],
      serviceFeeAmount: "500", serviceFeeCurrency: "JPY", serviceFeeCustomerPays: true,
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 1000, totalVnd: 270000, dueJpy: null });
  });

  it("recomputeOrderTotals_jpyPayCustomerNoRate_dueJpyHoldsJpyPartAndTotalVndHoldsVndPart", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      customer: { shipRatePerKg: "50000", payCurrency: "JPY" },
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      commissionPercent: "10",
      surchargeAmount: "300", surchargeCurrency: "JPY",
      intlShipAmount: "20000", intlShipCurrency: "VND",
      trackings: [{ id: "t1", unitPriceVndPerKg: null, shipRateCurrency: "VND", jpWeightKg: "2", vnWeightKg: null, carton: null }],
    }));
    mockPrisma.companyCost.findMany.mockResolvedValue([
      { currency: "JPY", amountOrig: "500", amountVnd: "0", exchangeRate: null },
      { currency: "VND", amountOrig: "30000", amountVnd: "30000", exchangeRate: null },
    ]);
    const result = await recomputeOrderTotals("o1");
    // dueJpy = 10000 + công 1000 + 300 + COD 500; totalVnd = 20000 + COD 30000 + ship 2kg*50000
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 150000, dueJpy: 11800 });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { totalQuote: 10000, totalVnd: 150000, dueJpy: 11800 } });
  });

  it("recomputeOrderTotals_seaCartonAndCustomerSeaRate_usesSeaRate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      customer: { shipRatePerKg: "50000", shipRateSeaPerKg: "20000" },
      trackings: [
        { id: "t1", unitPriceVndPerKg: null, shipRateCurrency: "VND", jpWeightKg: "2", vnWeightKg: null, carton: { route: "sea" } },
        { id: "t2", unitPriceVndPerKg: null, shipRateCurrency: "VND", jpWeightKg: "1", vnWeightKg: null, carton: { route: "air" } },
      ],
    }));
    const result = await recomputeOrderTotals("o1");
    // biển 2kg*20000 + bay 1kg*50000
    expect(result).toEqual({ totalQuote: 0, totalVnd: 90000, dueJpy: null });
  });

  it("recomputeOrderTotals_codJpyWithAndWithoutOwnRate_usesFixedVndOrOrderRate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      trackings: [{ id: "t1", unitPriceVndPerKg: "0", shipRateCurrency: "VND", jpWeightKg: "0", vnWeightKg: null }],
    }));
    mockPrisma.companyCost.findMany.mockResolvedValue([
      { currency: "JPY", amountOrig: "1000", amountVnd: "170000", exchangeRate: "170" },
      { currency: "JPY", amountOrig: "500", amountVnd: "0", exchangeRate: null },
    ]);
    const result = await recomputeOrderTotals("o1");
    // 170000 (đã chốt) + 500*180
    expect(result).toEqual({ totalQuote: 0, totalVnd: 260000, dueJpy: null });
  });

  it("recomputeOrderTotals_txProvided_usesTxAndDoesNotOpenNewTransaction", async () => {
    const tx: any = {
      order: { findUnique: vi.fn().mockResolvedValue(baseOrder({ exchangeRate: "100", items: [{ qty: 1, unitPriceJpy: "10", shipJpy: null }] })), update: vi.fn() },
      companyCost: { findMany: vi.fn() },
      debt: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
    };
    const result = await recomputeOrderTotals("o1", tx);
    expect(result).toEqual({ totalQuote: 10, totalVnd: 1000, dueJpy: null });
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { totalQuote: 10, totalVnd: 1000, dueJpy: null } });
    expect((prisma as any).$transaction).not.toHaveBeenCalled();
  });

  it("recomputeOrderTotals_noTx_wrapsTotalsAndDebtWriteInOneTransaction", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({ exchangeRate: "100", items: [{ qty: 1, unitPriceJpy: "10", shipJpy: null }] }));
    await recomputeOrderTotals("o1");
    expect((prisma as any).$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("customerShipRate", () => {
  it("customerShipRate_seaRouteWithSeaRate_returnsSeaRate", () => {
    expect(customerShipRate({ shipRatePerKg: "50000", shipRateSeaPerKg: "20000" }, "sea")).toBe(20000);
  });

  it("customerShipRate_seaRouteNoSeaRate_fallsBackToAirRate", () => {
    expect(customerShipRate({ shipRatePerKg: "50000", shipRateSeaPerKg: null }, "sea")).toBe(50000);
  });

  it("customerShipRate_noCustomer_returnsNull", () => {
    expect(customerShipRate(null, "air")).toBeNull();
  });
});

describe("orderCharges", () => {
  const base = {
    items: [{ qty: 2, unitPriceJpy: "1000", shipJpy: "200" }],
    shipAmount: null, shipCurrency: "JPY", surchargeAmount: null, surchargeCurrency: "JPY",
    discountAmount: "200", discountCurrency: "JPY", serviceFeeAmount: "10000", serviceFeeCurrency: "VND",
    jpDomesticShipAmount: null, jpDomesticShipCurrency: "JPY", intlShipAmount: null, intlShipCurrency: "VND",
    commissionPercent: "5",
  };

  it("orderCharges_jpyDiscountAndCommission_splitsJpyAndVndParts", () => {
    const r = orderCharges(base);
    // items 2200; Tổng 2000; công 100
    expect(r).toMatchObject({ itemsJpy: 2200, commissionJpy: 100, jpy: 2100, vnd: 10000, codJpy: 0, codVndFixed: 0 });
  });

  it("orderCharges_serviceFeeNotPaidByCustomer_vndPartExcludesFee", () => {
    expect(orderCharges({ ...base, serviceFeeCustomerPays: false }).vnd).toBe(0);
  });
});
