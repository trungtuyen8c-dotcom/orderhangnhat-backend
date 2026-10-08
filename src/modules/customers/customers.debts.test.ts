import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./customers.repository.js", () => ({ customerMoneyAggregates: vi.fn() }));
vi.mock("../sheets/customerSheetSync.service.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));

import { customerMoneyAggregates } from "./customers.repository.js";
import { customerVndDebts } from "./customers.service.js";

const sum = (customerId: string, v: string) => ({ customerId, _sum: { totalVnd: v, amountVnd: v, balance: v } });
const aggs = (o: { orders?: [string, string][]; deposits?: [string, string][]; payments?: { cid: string; amt: string; type?: string }[] }) =>
  vi.mocked(customerMoneyAggregates).mockResolvedValue([
    (o.orders ?? []).map(([c, v]) => sum(c, v)),
    (o.orders ?? []).map(([c, v]) => sum(c, v)),
    [],
    (o.deposits ?? []).map(([c, v]) => sum(c, v)),
    (o.payments ?? []).map((p) => ({ amountVnd: p.amt, type: p.type ?? "deposit", order: { customerId: p.cid } })),
  ] as never);

beforeEach(() => vi.clearAllMocks());

describe("customerVndDebts", () => {
  it("customerVndDebts_orderMinusConfirmedDepositAndPayment_returnsRemainingDebt", async () => {
    aggs({ orders: [["c1", "204000"]], deposits: [["c1", "100000"]], payments: [{ cid: "c1", amt: "50000" }] });
    expect((await customerVndDebts()).get("c1")).toBe(54000);
  });

  it("customerVndDebts_depositOnlyCustomer_listedAsCredit", async () => {
    aggs({ deposits: [["c2", "30000"]] });
    expect((await customerVndDebts()).get("c2")).toBe(-30000);
  });

  it("customerVndDebts_refund_addsBackToDebt", async () => {
    aggs({ orders: [["c1", "100000"]], payments: [{ cid: "c1", amt: "100000" }, { cid: "c1", amt: "20000", type: "refund" }] });
    expect((await customerVndDebts()).get("c1")).toBe(20000);
  });
});
