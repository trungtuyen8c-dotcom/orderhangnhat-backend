import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./customers.repository.js", () => ({ customerMoneyAggregates: vi.fn() }));
vi.mock("../sheets/customerSheetSync.service.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));

import { customerMoneyAggregates } from "./customers.repository.js";
import { customerVndDebts, customerDebts } from "./customers.service.js";

type Dep = { cid: string; amt: number; currency?: string; orig?: number };
const aggs = (o: { orders?: [string, number, number?][]; deposits?: Dep[]; payments?: { cid: string; amt: number; type?: string }[]; payCurrency?: [string, string][] }) =>
  vi.mocked(customerMoneyAggregates).mockResolvedValue({
    payCurrency: new Map(o.payCurrency ?? []),
    revenue: (o.orders ?? []).map(([customerId, totalVnd]) => ({ customerId, totalVnd })),
    orders: (o.orders ?? []).map(([customerId, totalVnd, dueJpy]) => ({ customerId, totalVnd, dueJpy: dueJpy ?? 0 })),
    deposits: (o.deposits ?? []).map((d) => ({ customerId: d.cid, currency: d.currency ?? "VND", amountVnd: d.amt, amountOrig: d.orig ?? d.amt })),
    payments: (o.payments ?? []).map((p) => ({ customerId: p.cid, type: p.type ?? "deposit", amountVnd: p.amt })),
  });

beforeEach(() => vi.clearAllMocks());

describe("customerVndDebts", () => {
  it("customerVndDebts_orderMinusConfirmedDepositAndPayment_returnsRemainingDebt", async () => {
    aggs({ orders: [["c1", 204000]], deposits: [{ cid: "c1", amt: 100000 }], payments: [{ cid: "c1", amt: 50000 }] });
    expect((await customerVndDebts()).get("c1")).toBe(54000);
  });

  it("customerVndDebts_depositOnlyCustomer_listedAsCredit", async () => {
    aggs({ deposits: [{ cid: "c2", amt: 30000 }] });
    expect((await customerVndDebts()).get("c2")).toBe(-30000);
  });

  it("customerVndDebts_refund_addsBackToDebt", async () => {
    aggs({ orders: [["c1", 100000]], payments: [{ cid: "c1", amt: 100000 }, { cid: "c1", amt: 20000, type: "refund" }] });
    expect((await customerVndDebts()).get("c1")).toBe(20000);
  });

  it("customerVndDebts_jpyCustomerJpyDeposit_doesNotReduceVndDebt", async () => {
    aggs({ payCurrency: [["c1", "JPY"]], orders: [["c1", 50000, 10000]], deposits: [{ cid: "c1", amt: 1800000, currency: "JPY", orig: 10000 }] });
    expect((await customerVndDebts()).get("c1")).toBe(50000);
  });
});

describe("customerDebts", () => {
  it("customerDebts_jpyCustomer_debtJpyIsDueJpyMinusJpyDeposits", async () => {
    aggs({
      payCurrency: [["c1", "JPY"]],
      orders: [["c1", 50000, 12000]],
      deposits: [{ cid: "c1", amt: 900000, currency: "JPY", orig: 5000 }, { cid: "c1", amt: 20000, currency: "VND" }],
    });
    const b = (await customerDebts()).get("c1");
    expect(b).toMatchObject({ debt: 30000, debtJpy: 7000 });
  });

  it("customerDebts_vndCustomerJpyDeposit_creditsVndByAmountVnd", async () => {
    aggs({ orders: [["c1", 1000000, 0]], deposits: [{ cid: "c1", amt: 900000, currency: "JPY", orig: 5000 }] });
    expect((await customerDebts()).get("c1")).toMatchObject({ debt: 100000, debtJpy: 0 });
  });
});
