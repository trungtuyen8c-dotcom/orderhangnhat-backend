import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../infrastructure/prisma.js", () => ({
  prisma: {
    debt: { groupBy: vi.fn() },
    customer: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    order: { findMany: vi.fn(), groupBy: vi.fn() },
    customerDeposit: { findMany: vi.fn(), groupBy: vi.fn(), count: vi.fn() },
    payment: { findMany: vi.fn() },
    tracking: { findMany: vi.fn() },
    fund: { findUnique: vi.fn() },
    fundTxn: { findMany: vi.fn(), count: vi.fn() },
    walletTxn: { findMany: vi.fn() },
  },
}));

import {
  accounting_customer_summary, accounting_debts, accounting_deposits, accounting_fund, accounting_monthly_report,
  accounting_opening_balances, accounting_statement,
} from "./accounting.js";
import { prisma } from "../../../infrastructure/prisma.js";

const mp = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  for (const model of Object.values(mp) as any[]) for (const fn of Object.values(model) as any[]) fn.mockResolvedValue([]);
  mp.fund.findUnique.mockResolvedValue(null);
});
afterEach(() => vi.useRealTimers());

describe("accounting_debts", () => {
  it("accounting_debts_noDebts_returnsEmptyWithoutCustomerLookup", async () => {
    expect(await accounting_debts()).toEqual([]);
    expect(mp.customer.findMany).not.toHaveBeenCalled();
  });

  it("accounting_debts_mixedBalances_dropsZeroAndSortsDescending", async () => {
    mp.debt.groupBy.mockResolvedValue([
      { customerId: "c1", _sum: { balance: "100" }, _max: { updatedAt: null } },
      { customerId: "c2", _sum: { balance: "0" }, _max: { updatedAt: null } },
      { customerId: "c3", _sum: { balance: "900" }, _max: { updatedAt: null } },
    ]);
    mp.customer.findMany.mockResolvedValue([{ id: "c3", name: "Lan", phone: "090" }]);
    const out = await accounting_debts();
    expect(out.map((r) => [r.customerId, r.name, r.balance])).toEqual([["c3", "Lan", 900], ["c1", "?", 100]]);
  });
});

describe("accounting_deposits", () => {
  it.each([
    ["pending", { isOpening: false, confirmed: false }],
    ["confirmed", { isOpening: false, confirmed: true }],
    ["fix_request", { isOpening: false, fixRequest: { not: null } }],
    ["unknown", { isOpening: false }],
  ])("accounting_deposits_status_%s_buildsWhereExcludingOpening", async (status, where) => {
    await accounting_deposits({ status });
    expect(mp.customerDeposit.findMany.mock.calls[0][0].where).toEqual(where);
  });

  it("accounting_deposits_fromTo_paidAtRangeUsesVnDayBounds", async () => {
    await accounting_deposits({ from: "2026-03-01", to: "2026-03-31" });
    expect(mp.customerDeposit.findMany.mock.calls[0][0].where.paidAt).toEqual({
      gte: new Date("2026-02-28T17:00:00.000Z"), lte: new Date("2026-03-31T16:59:59.999Z"),
    });
  });

  it("accounting_deposits_onlyFrom_paidAtHasOnlyLowerBound", async () => {
    await accounting_deposits({ from: "2026-03-01" });
    expect(mp.customerDeposit.findMany.mock.calls[0][0].where.paidAt).toEqual({ gte: new Date("2026-02-28T17:00:00.000Z") });
  });

  it("accounting_deposits_userNames_fullNameElseEmailElseNull", async () => {
    mp.customerDeposit.findMany.mockResolvedValue([
      { id: "d1", customerId: "c1", amountVnd: "1000", amountOrig: "1000", exchangeRate: null, recordedBy: "u1", confirmedBy: "u2" },
      { id: "d2", customerId: "c9", amountVnd: "1000", amountOrig: "1000", exchangeRate: "170.5", recordedBy: null, confirmedBy: "u404" },
    ]);
    mp.customer.findMany.mockResolvedValue([{ id: "c1", name: "Lan", code: "KH1" }]);
    mp.user.findMany.mockResolvedValue([{ id: "u1", fullName: "Ha", email: "ha@x" }, { id: "u2", fullName: "", email: "k@x" }]);
    const out = await accounting_deposits({});
    expect(out.map((r) => [r.customerName, r.recordedByName, r.confirmedByName, r.exchangeRate])).toEqual([
      ["Lan", "Ha", "k@x", null],
      [null, null, null, 170.5],
    ]);
  });
});

describe("accounting_opening_balances", () => {
  it("accounting_opening_balances_decimals_mappedToNumbersWithNullRate", async () => {
    mp.customerDeposit.findMany.mockResolvedValue([{ customerId: "c1", amountOrig: "500", currency: "JPY", exchangeRate: null, amountVnd: "85000" }]);
    expect(await accounting_opening_balances()).toEqual([{ customerId: "c1", amountOrig: 500, currency: "JPY", exchangeRate: null, amountVnd: 85000 }]);
  });
});

describe("accounting_customer_summary", () => {
  it("accounting_customer_summary_depositsPaymentsRefunds_noIsMuaMinusCocSortedDesc", async () => {
    mp.order.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { totalVnd: "1000" } }, { customerId: "c2", _sum: { totalVnd: "5000" } }]);
    mp.customerDeposit.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { amountVnd: "300" } }]);
    mp.payment.findMany.mockResolvedValue([
      { amountVnd: "200", type: "deposit", order: { customerId: "c1" } },
      { amountVnd: "50", type: "refund", order: { customerId: "c1" } },
      { amountVnd: "999", type: "deposit", order: null },
    ]);
    const out = await accounting_customer_summary();
    expect(out.map((r) => [r.customerId, r.mua, r.coc, r.no])).toEqual([["c2", 5000, 0, 5000], ["c1", 1000, 450, 550]]);
  });
});

describe("accounting_monthly_report", () => {
  it.each([
    ["missing", {}],
    ["bad format", { month: "2026-3" }],
  ])("accounting_monthly_report_month_%s_defaultsToCurrentVnMonth", async (_n, params) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-28T20:00:00Z"));
    expect((await accounting_monthly_report(params)).month).toBe("2026-03");
  });

  it("accounting_monthly_report_ordersAroundVnMonthBoundary_onlyVnMonthCounted", async () => {
    mp.order.findMany.mockResolvedValue([
      { customerId: "c1", totalVnd: "100", createdAt: new Date("2026-02-28T16:59:59Z") },
      { customerId: "c1", totalVnd: "200", createdAt: new Date("2026-02-28T17:00:00Z") },
    ]);
    expect((await accounting_monthly_report({ month: "2026-03" })).rows[0].mua).toBe(200);
  });

  it("accounting_monthly_report_weightsPaymentsAndDebt_aggregatedPerCustomerWithTotals", async () => {
    const inMonth = new Date("2026-03-10T05:00:00Z");
    mp.tracking.findMany.mockResolvedValue([
      { jpWeightKg: "2", vnWeightKg: "2.5", packedAt: inMonth, order: { customerId: "c1" } },
      { jpWeightKg: "1", vnWeightKg: null, packedAt: inMonth, order: { customerId: "c1" } },
    ]);
    mp.customerDeposit.findMany.mockResolvedValue([{ customerId: "c1", amountVnd: "1000", paidAt: inMonth }]);
    mp.payment.findMany.mockResolvedValue([{ amountVnd: "100", type: "refund", createdAt: inMonth, order: { customerId: "c1" } }]);
    mp.debt.groupBy.mockResolvedValue([{ customerId: "c1", _sum: { balance: "400" } }, { customerId: "c2", _sum: { balance: "0" } }]);
    const r = await accounting_monthly_report({ month: "2026-03" });
    expect(r.rows.map((x) => [x.customerId, x.canKg, x.traTrongThang, x.congNo])).toEqual([["c1", 3.5, 900, 400]]);
    expect(r.totals).toEqual({ mua: 0, canKg: 3.5, traTrongThang: 900, congNo: 400 });
  });
});

describe("accounting_fund", () => {
  it.each([
    ["pending", { confirmed: false, fixRequest: null }],
    ["confirmed", { confirmed: true }],
    ["fix_request", { fixRequest: { not: null } }],
    ["all", {}],
  ])("accounting_fund_status_%s_buildsWhere", async (status, where) => {
    await accounting_fund({ status });
    expect(mp.fundTxn.findMany.mock.calls[0][0].where).toEqual(where);
  });

  it("accounting_fund_noFundRow_balanceZero", async () => {
    expect((await accounting_fund({})).balance).toBe(0);
  });

  it("accounting_fund_txns_decimalsToNumbersAndRecorderName", async () => {
    mp.fund.findUnique.mockResolvedValue({ balance: "12000" });
    mp.fundTxn.findMany.mockResolvedValue([{ id: "f1", amountYen: "3000", rate: null, recordedBy: "u1", confirmedBy: null }]);
    mp.user.findMany.mockResolvedValue([{ id: "u1", fullName: null, email: "a@x" }]);
    const r = await accounting_fund({});
    expect(r.balance).toBe(12000);
    expect(r.txns[0]).toMatchObject({ amountYen: 3000, rate: null, recordedByName: "a@x", confirmedByName: null });
  });
});

describe("accounting_statement", () => {
  const txn = (over: Record<string, unknown>) => ({
    id: "t", amount: "0", type: "manual", category: null, note: null, reconciled: false, statementRef: null,
    refOrderId: null, refDepositId: null, createdAt: new Date("2026-03-10T05:00:00Z"), ...over,
  });

  it("accounting_statement_noWalletId_returnsEmpty", async () => {
    expect(await accounting_statement({})).toEqual({ rows: [], balance: 0 });
    expect(mp.walletTxn.findMany).not.toHaveBeenCalled();
  });

  it("accounting_statement_txns_runningBalanceAndNewestFirst", async () => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "a", amount: "1000", createdAt: new Date("2026-03-01T05:00:00Z") }),
      txn({ id: "b", amount: "-250", createdAt: new Date("2026-03-02T05:00:00Z") }),
    ]);
    const r = await accounting_statement({ walletId: "w1" });
    expect(r.rows.map((x) => [x.id, x.balance])).toEqual([["b", 750], ["a", 1000]]);
    expect(r.balance).toBe(750);
  });

  it.each([
    ["true string", "true", ["p"]],
    ["false string", "false", ["r", "p"]],
    ["absent", undefined, ["r", "p"]],
  ])("accounting_statement_onlyPending_%s", async (_n, onlyPending, ids) => {
    mp.walletTxn.findMany.mockResolvedValue([txn({ id: "p" }), txn({ id: "r", reconciled: true })]);
    const r = await accounting_statement({ walletId: "w1", onlyPending });
    expect(r.rows.map((x) => x.id)).toEqual(ids);
  });

  it("accounting_statement_fromToVnDay_includesEarlyMorningVnTxnOnly", async () => {
    mp.walletTxn.findMany.mockResolvedValue([
      txn({ id: "vn05", createdAt: new Date("2026-03-04T17:30:00Z") }),
      txn({ id: "vn06", createdAt: new Date("2026-03-05T17:30:00Z") }),
    ]);
    const r = await accounting_statement({ walletId: "w1", from: "2026-03-05", to: "2026-03-05" });
    expect(r.rows.map((x) => x.id)).toEqual(["vn05"]);
  });

  const linkedFixtures = () => {
    mp.walletTxn.findMany.mockResolvedValue([txn({ id: "o", refOrderId: "o1" }), txn({ id: "d", refDepositId: "d1" })]);
    mp.order.findMany.mockResolvedValue([{ id: "o1", code: "OD1", fixRequest: null, customer: { name: "Lan", phone: null }, trackings: [{ code: "JP1", vnTrackingCode: "VN9" }] }]);
    mp.customerDeposit.findMany.mockResolvedValue([{ id: "d1", customerId: "c2", fixRequest: null }]);
    mp.customer.findMany.mockResolvedValue([{ id: "c2", name: "Lanh", phone: null }]);
  };

  it("accounting_statement_customerFilter_matchesOrderAndDepositCustomersCaseInsensitive", async () => {
    linkedFixtures();
    expect((await accounting_statement({ walletId: "w1", customer: " LAN" })).rows.map((x) => x.id)).toEqual(["d", "o"]);
  });

  it("accounting_statement_trackingFilter_matchesVnTrackingCodeCaseInsensitive", async () => {
    linkedFixtures();
    expect((await accounting_statement({ walletId: "w1", tracking: "vn9" })).rows.map((x) => x.id)).toEqual(["o"]);
  });
});
