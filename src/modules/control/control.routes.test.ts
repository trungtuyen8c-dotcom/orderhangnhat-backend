import { describe, it, expect } from "vitest";
import { summarizeOverdueDebts } from "./control.routes.js";

const NOW = new Date("2026-03-05T00:00:00Z").getTime();
const DAY = 86400000;
const cfg = { thresholdVnd: 100000, overdueDays: 30 };
const customers = [
  { id: "c1", name: "C1", code: null, phone: null },
  { id: "c2", name: "C2", code: null, phone: null },
  { id: "c3", name: "C3", code: null, phone: null },
  { id: "c4", name: "C4", code: null, phone: null },
  { id: "c5", name: "C5", code: null, phone: null },
  { id: "c6", name: "C6", code: null, phone: null },
];

describe("summarizeOverdueDebts", () => {
  it("summarizeOverdueDebts_vndDebtAboveThreshold_includesCustomer", () => {
    const debtAgg = [{ customerId: "c1", currency: "VND", _sum: { balance: "500000" } }];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list).toEqual([{ customerId: "c1", name: "C1", code: null, phone: null, balanceVnd: 500000, balanceJpy: 0, days: 0 }]);
  });

  // Regression: trước đây debt.groupBy lọc where:{currency:"VND"} nên nợ ¥ vô hình hoàn toàn dù nợ bao lâu.
  it("summarizeOverdueDebts_jpyOnlyDebtWithinOverdueDays_excludesCustomer", () => {
    const debtAgg = [{ customerId: "c2", currency: "JPY", _sum: { balance: "20000" } }];
    const oldest = new Map([["c2", new Date(NOW - 10 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([]);
  });

  it("summarizeOverdueDebts_jpyOnlyDebtPastOverdueDays_includesCustomer", () => {
    const debtAgg = [{ customerId: "c3", currency: "JPY", _sum: { balance: "20000" } }];
    const oldest = new Map([["c3", new Date(NOW - 40 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([{ customerId: "c3", name: "C3", code: null, phone: null, balanceVnd: 0, balanceJpy: 20000, days: 40 }]);
  });

  it("summarizeOverdueDebts_customerWithBothCurrencies_keepsThemSeparate", () => {
    const debtAgg = [
      { customerId: "c4", currency: "VND", _sum: { balance: "300000" } },
      { customerId: "c4", currency: "JPY", _sum: { balance: "15000" } },
    ];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list[0].balanceVnd).toBe(300000);
    expect(list[0].balanceJpy).toBe(15000);
  });

  it("summarizeOverdueDebts_belowThresholdAndNotOverdueDays_excludesCustomer", () => {
    const debtAgg = [{ customerId: "c5", currency: "VND", _sum: { balance: "50000" } }];
    const oldest = new Map([["c5", new Date(NOW - 5 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([]);
  });

  it("summarizeOverdueDebts_multipleCustomers_sortsByVndBalanceDescending", () => {
    const debtAgg = [
      { customerId: "c1", currency: "VND", _sum: { balance: "500000" } },
      { customerId: "c6", currency: "VND", _sum: { balance: "800000" } },
    ];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list.map((r) => r.customerId)).toEqual(["c6", "c1"]);
  });
});
