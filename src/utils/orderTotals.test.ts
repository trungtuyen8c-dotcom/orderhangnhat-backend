import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    order: { findUnique: vi.fn(), update: vi.fn() },
    companyCost: { groupBy: vi.fn() },
    debt: { findFirst: vi.fn(), update: vi.fn() },
  },
}));

import { trackingShipVnd, computeDebtBalance, recomputeOrderTotals } from "./orderTotals.js";
import { prisma } from "../db.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  companyCost: { groupBy: ReturnType<typeof vi.fn> };
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
    mockPrisma.companyCost.groupBy.mockResolvedValue([]);
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
    expect(result).toEqual({ totalQuote: 2000, totalVnd: 360000 });
    expect(mockPrisma.order.update).toHaveBeenCalledWith({ where: { id: "o1" }, data: { totalQuote: 2000, totalVnd: 360000 } });
  });

  it("recomputeOrderTotals_jpyItemsNoRate_setsTotalVndNull", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      items: [{ qty: 1, unitPriceJpy: "500", shipJpy: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 500, totalVnd: null });
  });

  it("recomputeOrderTotals_trackingNeedsRateButNoRate_setsTotalVndNull", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      trackings: [{ id: "t1", unitPriceVndPerKg: "300", shipRateCurrency: "JPY", jpWeightKg: "2", vnWeightKg: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result?.totalVnd).toBeNull();
    expect(mockPrisma.companyCost.groupBy).toHaveBeenCalled();
  });

  it("recomputeOrderTotals_customerDefaultShipRateUsedWhenTrackingRateMissing_includesShipInTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      customer: { shipRatePerKg: "50000" },
      trackings: [{ id: "t1", unitPriceVndPerKg: null, shipRateCurrency: "VND", jpWeightKg: "2", vnWeightKg: null }],
    }));
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 100000 });
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
    expect(result).toEqual({ totalQuote: 0, totalVnd: 100000 });
  });

  it("recomputeOrderTotals_companyCostChakubaraiRows_addsCodVndToTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      trackings: [{ id: "t1", unitPriceVndPerKg: "0", shipRateCurrency: "VND", jpWeightKg: "0", vnWeightKg: null }],
    }));
    mockPrisma.companyCost.groupBy.mockResolvedValue([{ refId: "t1", _sum: { amountVnd: "250000" } }]);
    const result = await recomputeOrderTotals("o1");
    expect(result).toEqual({ totalQuote: 0, totalVnd: 250000 });
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
    expect(result).toEqual({ totalQuote: 0, totalVnd: 55000 });
  });

  it("recomputeOrderTotals_discountAmountJpyWithRate_subtractsConvertedDiscountFromTotal", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      discountAmount: "1000", discountCurrency: "JPY",
    }));
    const result = await recomputeOrderTotals("o1");
    // subtotalJpy(10000)*180 - discount(1000)*180 = 1800000 - 180000 = 1620000
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 1620000 });
  });

  it("recomputeOrderTotals_commissionPercentSet_addsPercentOfSubtotalToTotalVndBeforeRate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      commissionPercent: "10",
    }));
    const result = await recomputeOrderTotals("o1");
    // commissionJpy = 10000*10% = 1000 -> (10000+1000)*180 = 1980000. Công không cộng vào totalQuote (giá mua thật).
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 1980000 });
  });

  it("recomputeOrderTotals_commissionAppliesOnlyToItemsNotOrderShipFee_excludesShipAmountFromCommissionBase", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(baseOrder({
      exchangeRate: "180",
      items: [{ qty: 1, unitPriceJpy: "10000", shipJpy: null }],
      commissionPercent: "10",
      shipAmount: "5000", shipCurrency: "JPY",
    }));
    const result = await recomputeOrderTotals("o1");
    // commissionJpy = 10000*10% = 1000 (KHÔNG tính trên shipAmount) -> (10000+1000)*180 + 5000*180 = 1980000+900000
    expect(result).toEqual({ totalQuote: 10000, totalVnd: 2880000 });
  });
});
