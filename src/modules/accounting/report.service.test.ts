import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    debt: { groupBy: vi.fn() },
    customer: { findMany: vi.fn() },
    order: { findMany: vi.fn(), groupBy: vi.fn() },
    customerDeposit: { findMany: vi.fn(), groupBy: vi.fn() },
    payment: { findMany: vi.fn() },
    tracking: { findMany: vi.fn() },
    expense: { findMany: vi.fn() },
    wallet: { findUnique: vi.fn() },
    walletTxn: { findMany: vi.fn() },
    walletDailyActual: { findMany: vi.fn() },
  },
}));

vi.mock("../customers/customers.service.js", () => ({ customerVndDebts: vi.fn() }));

import { customerVndDebts } from "../customers/customers.service.js";
import { customerLedger, customerSummary, debtsByCustomer, expensesMonthly, monthlyReport, statement, walletDailySummary } from "./report.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

const mp = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(mp) as any[]) for (const fn of Object.values(model) as any[]) fn.mockResolvedValue([]);
  mp.wallet.findUnique.mockResolvedValue(null);
  vi.mocked(customerVndDebts).mockResolvedValue(new Map());
});
const debts = (entries: [string, number][]) => vi.mocked(customerVndDebts).mockResolvedValue(new Map(entries));
afterEach(() => vi.useRealTimers());

// 2026-03-01 03:00 giờ VN = 2026-02-28 20:00 UTC: tháng hiện tại theo VN là 2026-03, theo UTC là 2026-02.
const freezeAtVnMarchFirstEarlyMorning = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-28T20:00:00Z"));
};

async function rejection(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AppError; }
  throw new Error("expected rejection");
}

describe("debtsByCustomer", () => {
  it("debtsByCustomer_mixedBalances_dropsZeroAndSortsDescending", async () => {
    debts([["aaaaaaaa-1", 100], ["bbbbbbbb-2", 0], ["cccccccc-3", 500], ["dddddddd-4", -20]]);
    const out = await debtsByCustomer();
    expect(out.map((r) => [r.customerId, r.balance])).toEqual([["cccccccc-3", 500], ["aaaaaaaa-1", 100], ["dddddddd-4", -20]]);
  });

  it("debtsByCustomer_any_doesNotReadStaleDebtTable", async () => {
    await debtsByCustomer();
    expect(mp.debt.groupBy).not.toHaveBeenCalled();
  });

  it("debtsByCustomer_customerRecordMissing_nameQuestionMarkAndPhoneNull", async () => {
    debts([["abcdef12-xyz", 10]]);
    const [row] = await debtsByCustomer();
    expect(row).toMatchObject({ name: "?", phone: null });
  });

  it("debtsByCustomer_any_codeIsFirst8CharsOfIdUppercased", async () => {
    debts([["abcdef12-3456", 10]]);
    mp.customer.findMany.mockResolvedValue([{ id: "abcdef12-3456", name: "Lan", phone: "090" }]);
    const [row] = await debtsByCustomer();
    expect(row).toMatchObject({ code: "ABCDEF12", name: "Lan", phone: "090" });
  });

  it("debtsByCustomer_noDebts_returnsEmpty", async () => {
    expect(await debtsByCustomer()).toEqual([]);
  });
});

describe("customerLedger", () => {
  it("customerLedger_pendingDeposit_notDeductedFromDebtButReportedAsPending", async () => {
    mp.order.findMany.mockResolvedValue([{ totalVnd: "1000000", createdAt: new Date("2026-03-05T05:00:00Z") }]);
    mp.customerDeposit.findMany.mockResolvedValue([
      { amountVnd: "300000", confirmed: true, paidAt: new Date("2026-03-06T05:00:00Z") },
      { amountVnd: "200000", confirmed: false, paidAt: new Date("2026-03-07T05:00:00Z") },
    ]);
    const r = await customerLedger("c1");
    expect(r).toMatchObject({ depositTotal: 300000, pendingTotal: 200000, debt: 700000 });
  });

  it("customerLedger_refundPayment_subtractsFromPaidTotal", async () => {
    mp.order.findMany.mockResolvedValue([{ totalVnd: "1000000", createdAt: new Date("2026-03-05T05:00:00Z") }]);
    mp.payment.findMany.mockResolvedValue([
      { amountVnd: "400000", type: "deposit", createdAt: new Date("2026-03-05T05:00:00Z") },
      { amountVnd: "50000", type: "refund", createdAt: new Date("2026-03-06T05:00:00Z") },
    ]);
    const r = await customerLedger("c1");
    expect(r).toMatchObject({ paymentTotal: 350000, paidTotal: 350000, debt: 650000 });
  });

  it("customerLedger_orderWithNullTotal_countsAsZero", async () => {
    mp.order.findMany.mockResolvedValue([
      { totalVnd: null, createdAt: new Date("2026-03-05T05:00:00Z") },
      { totalVnd: "1000", createdAt: new Date("2026-03-05T05:00:00Z") },
    ]);
    expect((await customerLedger("c1")).orderTotal).toBe(1000);
  });

  it("customerLedger_ordersAcrossMonths_byMonthSortedWithCarriedOverBalance", async () => {
    mp.order.findMany.mockResolvedValue([
      { totalVnd: "500", createdAt: new Date("2026-04-10T05:00:00Z") },
      { totalVnd: "1000", createdAt: new Date("2026-02-10T05:00:00Z") },
    ]);
    mp.customerDeposit.findMany.mockResolvedValue([{ amountVnd: "1500", confirmed: true, paidAt: new Date("2026-03-10T05:00:00Z") }]);
    const r = await customerLedger("c1");
    expect(r.byMonth).toEqual([
      { month: "2026-02", order: 1000, paid: 0, balance: -1000 },
      { month: "2026-03", order: 0, paid: 1500, balance: 500 },
      { month: "2026-04", order: 500, paid: 0, balance: 0 },
    ]);
  });

  it("customerLedger_orderAtVnMonthStartWhichIsPrevUtcMonth_bucketsIntoVnMonth", async () => {
    mp.order.findMany.mockResolvedValue([{ totalVnd: "1000", createdAt: new Date("2026-02-28T17:00:00Z") }]);
    expect((await customerLedger("c1")).byMonth.map((m) => m.month)).toEqual(["2026-03"]);
  });

  it("customerLedger_pendingDeposit_notInByMonth", async () => {
    mp.customerDeposit.findMany.mockResolvedValue([{ amountVnd: "1500", confirmed: false, paidAt: new Date("2026-03-10T05:00:00Z") }]);
    expect((await customerLedger("c1")).byMonth).toEqual([]);
  });
});

describe("customerSummary", () => {
  it("customerSummary_depositsPaymentsAndRefunds_cocSumsAllAndNoIsMuaMinusCoc", async () => {
    mp.order.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { totalVnd: "1000" } }]);
    mp.customerDeposit.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { amountVnd: "300" } }]);
    mp.payment.findMany.mockResolvedValue([
      { amountVnd: "200", type: "deposit", order: { customerId: "c1" } },
      { amountVnd: "50", type: "refund", order: { customerId: "c1" } },
    ]);
    const [row] = await customerSummary();
    expect(row).toMatchObject({ mua: 1000, coc: 450, no: 550 });
  });

  it("customerSummary_paymentWithoutOrder_ignored", async () => {
    mp.payment.findMany.mockResolvedValue([{ amountVnd: "200", type: "deposit", order: null }]);
    expect(await customerSummary()).toEqual([]);
  });

  it("customerSummary_customerOnlyHasDeposit_appearsWithNegativeDebtAndSortedLast", async () => {
    mp.order.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { totalVnd: "1000" } }]);
    mp.customerDeposit.groupBy.mockResolvedValue([{ customerId: "c2", _sum: { amountVnd: "300" } }]);
    mp.customer.findMany.mockResolvedValue([{ id: "c2", name: "Mai", code: "KH2" }]);
    const out = await customerSummary();
    expect(out.map((r) => [r.customerId, r.no])).toEqual([["c1", 1000], ["c2", -300]]);
    expect(out[0]).toMatchObject({ name: "?", code: null });
    expect(out[1]).toMatchObject({ name: "Mai", code: "KH2" });
  });
});

describe("monthlyReport", () => {
  it.each([
    ["undefined", undefined],
    ["missing leading zero", "2026-3"],
    ["number", 202603],
    ["garbage", "abc"],
  ])("monthlyReport_invalidMonth_%s_defaultsToCurrentVnMonth", async (_n, q) => {
    freezeAtVnMarchFirstEarlyMorning();
    expect((await monthlyReport(q)).month).toBe("2026-03");
  });

  it("monthlyReport_ordersAroundVnMonthBoundary_onlyVnMonthOrdersCountInMua", async () => {
    mp.order.findMany.mockResolvedValue([
      { customerId: "c1", totalVnd: "100", createdAt: new Date("2026-02-28T16:59:59Z") },
      { customerId: "c1", totalVnd: "200", createdAt: new Date("2026-02-28T17:00:00Z") },
      { customerId: "c1", totalVnd: "400", createdAt: new Date("2026-03-31T16:59:59Z") },
      { customerId: "c1", totalVnd: "800", createdAt: new Date("2026-03-31T17:00:00Z") },
    ]);
    expect((await monthlyReport("2026-03")).rows[0].mua).toBe(600);
  });

  it("monthlyReport_trackingWeights_prefersVnWeightElseJpElseZero", async () => {
    const packedAt = new Date("2026-03-10T05:00:00Z");
    mp.tracking.findMany.mockResolvedValue([
      { jpWeightKg: "2", vnWeightKg: "2.5", packedAt, order: { customerId: "c1" } },
      { jpWeightKg: "1.25", vnWeightKg: null, packedAt, order: { customerId: "c1" } },
      { jpWeightKg: null, vnWeightKg: null, packedAt, order: { customerId: "c1" } },
    ]);
    expect((await monthlyReport("2026-03")).rows[0].canKg).toBe(3.75);
  });

  it("monthlyReport_trackingPackedOtherMonth_excludedFromCanKg", async () => {
    mp.tracking.findMany.mockResolvedValue([{ jpWeightKg: "2", vnWeightKg: null, packedAt: new Date("2026-04-01T01:00:00Z"), order: { customerId: "c1" } }]);
    expect((await monthlyReport("2026-03")).rows).toEqual([]);
  });

  it("monthlyReport_depositsPaymentsRefundsInMonth_traTrongThangIsNet", async () => {
    mp.customerDeposit.findMany.mockResolvedValue([
      { customerId: "c1", amountVnd: "1000", paidAt: new Date("2026-03-02T05:00:00Z") },
      { customerId: "c1", amountVnd: "9999", paidAt: new Date("2026-02-02T05:00:00Z") },
    ]);
    mp.payment.findMany.mockResolvedValue([
      { amountVnd: "300", type: "deposit", createdAt: new Date("2026-03-03T05:00:00Z"), order: { customerId: "c1" } },
      { amountVnd: "100", type: "refund", createdAt: new Date("2026-03-04T05:00:00Z"), order: { customerId: "c1" } },
    ]);
    expect((await monthlyReport("2026-03")).rows[0].traTrongThang).toBe(1200);
  });

  it("monthlyReport_customerWithOnlyCumulativeDebt_listedWithCongNo", async () => {
    debts([["c1", 750], ["c2", 0]]);
    const r = await monthlyReport("2026-03");
    expect(r.rows.map((x) => [x.customerId, x.congNo, x.mua])).toEqual([["c1", 750, 0]]);
  });

  it("monthlyReport_multipleCustomers_sortedByMuaDescWithTotals", async () => {
    const createdAt = new Date("2026-03-10T05:00:00Z");
    mp.order.findMany.mockResolvedValue([
      { customerId: "c1", totalVnd: "100", createdAt },
      { customerId: "c2", totalVnd: "300", createdAt },
    ]);
    debts([["c1", 50]]);
    mp.customer.findMany.mockResolvedValue([{ id: "c2", name: "B", code: "K2" }]);
    const r = await monthlyReport("2026-03");
    expect(r.rows.map((x) => x.customerId)).toEqual(["c2", "c1"]);
    expect(r.totals).toEqual({ canKg: 0, mua: 400, traTrongThang: 0, congNo: 50 });
  });
});

describe("expensesMonthly", () => {
  const exp = (over: Record<string, unknown>) => ({ id: "e", kind: "other", amountVnd: "0", currency: "VND", amountOrig: "0", note: null, orderId: null, incurredAt: new Date("2026-03-10T05:00:00Z"), ...over });

  it("expensesMonthly_mixedKinds_totalCompensationOtherSplit", async () => {
    mp.expense.findMany.mockResolvedValue([
      exp({ id: "e1", kind: "compensation", amountVnd: "300" }),
      exp({ id: "e2", kind: "other", amountVnd: "200" }),
      exp({ id: "e3", kind: "ship", amountVnd: "100" }),
    ]);
    const r = await expensesMonthly("2026-03");
    expect([r.total, r.compensation, r.other]).toEqual([600, 300, 300]);
  });

  it("expensesMonthly_expenseAtVnMonthStart_includedAndPrevMonthExcluded", async () => {
    mp.expense.findMany.mockResolvedValue([
      exp({ id: "in", amountVnd: "10", incurredAt: new Date("2026-02-28T17:00:00Z") }),
      exp({ id: "out", amountVnd: "20", incurredAt: new Date("2026-02-28T16:59:59Z") }),
    ]);
    const r = await expensesMonthly("2026-03");
    expect(r.rows.map((x) => x.id)).toEqual(["in"]);
    expect(r.total).toBe(10);
  });

  it("expensesMonthly_expenseLinkedToOrder_exposesOrderCodeAndCustomerName", async () => {
    mp.expense.findMany.mockResolvedValue([exp({ id: "e1", orderId: "o1" }), exp({ id: "e2", orderId: null })]);
    mp.order.findMany.mockResolvedValue([{ id: "o1", code: "OD1", customer: { name: "Lan" } }]);
    const r = await expensesMonthly("2026-03");
    expect(r.rows.map((x) => [x.orderCode, x.customerName])).toEqual([["OD1", "Lan"], [null, null]]);
  });

  it("expensesMonthly_invalidMonth_defaultsToCurrentVnMonth", async () => {
    freezeAtVnMarchFirstEarlyMorning();
    expect((await expensesMonthly("03/2026")).month).toBe("2026-03");
  });
});

describe("walletDailySummary", () => {
  const wallet = { id: "w1", name: "MB", currency: "VND", balance: "1000" };

  it("walletDailySummary_walletMissing_throws404WalletNotFound", async () => {
    const e = await rejection(walletDailySummary("x", "2026-02"));
    expect([e.status, e.code]).toEqual([404, "WALLET_NOT_FOUND"]);
  });

  it.each([
    ["2026-02", 28],
    ["2024-02", 29],
    ["2026-04", 30],
    ["2026-12", 31],
  ])("walletDailySummary_month_%s_returns%iDays", async (month, n) => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    const r = await walletDailySummary("w1", month);
    expect(r.days).toHaveLength(n);
  });

  it("walletDailySummary_invalidMonth_defaultsToCurrentVnMonth", async () => {
    freezeAtVnMarchFirstEarlyMorning();
    mp.wallet.findUnique.mockResolvedValue(wallet);
    expect((await walletDailySummary("w1", "bad")).month).toBe("2026-03");
  });

  it("walletDailySummary_noTxns_everyDayOpeningAndClosingEqualCurrentBalance", async () => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    const r = await walletDailySummary("w1", "2026-02");
    expect(r.days[0]).toMatchObject({ opening: 1000, closing: 1000 });
    expect(r.days[27]).toMatchObject({ opening: 1000, closing: 1000 });
  });

  it("walletDailySummary_txnAfterMonth_subtractedFromMonthEndClosing", async () => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    // 2026-02-28 17:30 UTC = 01/03 00:30 giờ VN -> thuộc tháng 3, không phải ngày 28/2.
    mp.walletTxn.findMany.mockResolvedValue([{ amount: "200", createdAt: new Date("2026-02-28T17:30:00Z") }]);
    const r = await walletDailySummary("w1", "2026-02");
    expect(r.days[27]).toMatchObject({ date: "2026-02-28", opening: 800, closing: 800 });
  });

  it("walletDailySummary_txnInEarlyVnMorning_bucketedToVnDayWithOpeningBeforeClosingAfter", async () => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    // 2026-02-09 17:30 UTC = 10/02 00:30 giờ VN.
    mp.walletTxn.findMany.mockResolvedValue([{ amount: "300", createdAt: new Date("2026-02-09T17:30:00Z") }]);
    const r = await walletDailySummary("w1", "2026-02");
    expect(r.days[8]).toMatchObject({ date: "2026-02-09", opening: 700, closing: 700 });
    expect(r.days[9]).toMatchObject({ date: "2026-02-10", opening: 700, closing: 1000 });
  });

  it("walletDailySummary_manualOpeningBalanceWithoutTxn_firstDayOpeningIsNotZero", async () => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    mp.walletTxn.findMany.mockResolvedValue([{ amount: "300", createdAt: new Date("2026-02-10T05:00:00Z") }]);
    const r = await walletDailySummary("w1", "2026-02");
    expect(r.days[0].opening).toBe(700);
  });

  it("walletDailySummary_actualEnteredForDay_diffIsActualMinusClosing", async () => {
    mp.wallet.findUnique.mockResolvedValue(wallet);
    mp.walletDailyActual.findMany.mockResolvedValue([{ date: new Date("2026-02-10T00:00:00Z"), actualBalance: "1050" }]);
    const r = await walletDailySummary("w1", "2026-02");
    expect(r.days[9]).toMatchObject({ actual: 1050, diff: 50 });
    expect(r.days[8]).toMatchObject({ actual: null, diff: null });
  });
});

describe("statement", () => {
  const txn = (over: Record<string, unknown>) => ({
    id: "t", walletId: "w1", amount: "0", type: "manual", category: null, note: null, reconciled: false, statementRef: null,
    refOrderId: null, refDepositId: null, createdAt: new Date("2026-03-10T05:00:00Z"), ...over,
  });

  it("statement_noWalletId_returnsEmptyWithoutQuerying", async () => {
    expect(await statement({ walletId: null })).toEqual({ rows: [], balance: 0 });
    expect(mp.walletTxn.findMany).not.toHaveBeenCalled();
  });

  it("statement_severalTxns_runningBalanceAscAndRowsNewestFirst", async () => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "a", amount: "1000", createdAt: new Date("2026-03-01T05:00:00Z") }),
      txn({ id: "b", amount: "-300", createdAt: new Date("2026-03-02T05:00:00Z") }),
      txn({ id: "c", amount: "50", createdAt: new Date("2026-03-03T05:00:00Z") }),
    ]);
    const r = await statement({ walletId: "w1" });
    expect(r.rows.map((x) => [x.id, x.balance])).toEqual([["c", 750], ["b", 700], ["a", 1000]]);
    expect(r.balance).toBe(750);
  });

  it("statement_fromFilter_rowBalanceStillIncludesEarlierTxns", async () => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "a", amount: "1000", createdAt: new Date("2026-03-01T05:00:00Z") }),
      txn({ id: "b", amount: "-300", createdAt: new Date("2026-03-05T05:00:00Z") }),
    ]);
    const r = await statement({ walletId: "w1", from: "2026-03-05" });
    expect(r.rows.map((x) => [x.id, x.balance])).toEqual([["b", 700]]);
  });

  it("statement_fromToAsVnDays_includesEarlyMorningVnTxnAndExcludesNextVnDay", async () => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "vn05-0030", createdAt: new Date("2026-03-04T17:30:00Z") }),
      txn({ id: "vn06-0030", createdAt: new Date("2026-03-05T17:30:00Z") }),
    ]);
    const r = await statement({ walletId: "w1", from: "2026-03-05", to: "2026-03-05" });
    expect(r.rows.map((x) => x.id)).toEqual(["vn05-0030"]);
  });

  it("statement_txnLinkedToDeposit_customerResolvedViaDeposit", async () => {
    mp.walletTxn.findMany.mockResolvedValue([txn({ id: "a", refDepositId: "d1" })]);
    mp.customerDeposit.findMany.mockResolvedValue([{ id: "d1", customerId: "c1", fixRequest: "sai số" }]);
    mp.customer.findMany.mockResolvedValue([{ id: "c1", name: "Lan", phone: "090" }]);
    const [row] = (await statement({ walletId: "w1" })).rows;
    expect(row).toMatchObject({ customer: "Lan", phone: "090", fixRequest: "sai số", depositId: "d1" });
  });

  it("statement_txnLinkedToOrder_trackingsIncludeJpAndVnCodesSkippingNull", async () => {
    mp.walletTxn.findMany.mockResolvedValue([txn({ id: "a", refOrderId: "o1" })]);
    mp.order.findMany.mockResolvedValue([{ id: "o1", code: "OD1", fixRequest: null, customer: { name: "Lan", phone: null }, trackings: [{ code: "JP1", vnTrackingCode: "VN1" }, { code: "JP2", vnTrackingCode: null }] }]);
    const [row] = (await statement({ walletId: "w1" })).rows;
    expect(row).toMatchObject({ orderCode: "OD1", customer: "Lan", trackings: ["JP1", "VN1", "JP2"] });
  });

  it("statement_nullCategoryAndNote_fallBackToTypeAndStatementRef", async () => {
    mp.walletTxn.findMany.mockResolvedValue([txn({ type: "deposit", statementRef: "file.csv#3" })]);
    const [row] = (await statement({ walletId: "w1" })).rows;
    expect([row.category, row.note]).toEqual(["deposit", "file.csv#3"]);
  });

  it.each([
    ["customer case-insensitive", { customer: "  LAN " }, ["o"]],
    ["tracking matches vn code", { tracking: "vn9" }, ["o"]],
    ["q matches order code", { q: "od1" }, ["o"]],
    ["q matches type", { q: "FEE" }, ["fee"]],
    ["onlyPending drops reconciled", { onlyPending: true }, ["fee"]],
  ])("statement_filter_%s", async (_n, filter, ids) => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "o", refOrderId: "o1", type: "order_payment", reconciled: true }),
      txn({ id: "fee", type: "fee" }),
    ]);
    mp.order.findMany.mockResolvedValue([{ id: "o1", code: "OD1", fixRequest: null, customer: { name: "Lan", phone: null }, trackings: [{ code: "JP1", vnTrackingCode: "VN9" }] }]);
    const r = await statement({ walletId: "w1", ...filter });
    expect(r.rows.map((x) => x.id)).toEqual(ids);
  });
});
