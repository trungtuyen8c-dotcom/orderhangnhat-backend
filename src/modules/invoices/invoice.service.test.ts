import { describe, it, expect, vi } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: {} }));

const { monthRangeOr400, summarize, toPendingItem, orderAmountJpy } = await import("./invoice.service.js");
const { pendingWhere } = await import("./invoice.repository.js");

describe("monthRangeOr400", () => {
  it("month_givenValid_thenVnMonthBounds", () => {
    const r = monthRangeOr400("2026-12");
    expect(r.start.toISOString()).toBe("2026-11-30T17:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  it.each([undefined, "", "2026-13", "2026-1", "abc", "2026-00"])("month_givenInvalid_%s_then400", (m) => {
    expect(() => monthRangeOr400(m)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("pendingWhere", () => {
  const range = { start: new Date("2026-05-31T17:00:00Z"), end: new Date("2026-06-30T17:00:00Z") };

  it("where_givenMonthOnly_thenNeverInvoicedPurchasedItemsInMonth", () => {
    expect(pendingWhere(range)).toEqual({
      invoiceItems: { none: {} },
      order: {
        orderDate: { gte: range.start, lt: range.end },
        status: { notIn: ["cancelled", "draft"] },
        externalWarehouse: false,
        items: { some: {} },
      },
    });
  });

  it("where_givenUnpackedAndQ_thenPackedNullAndSearchOr", () => {
    const w = pendingWhere({ ...range, unpacked: true, q: "JA1" });
    expect(w.packedAt).toBeNull();
    const c = { contains: "JA1", mode: "insensitive" };
    expect(w.AND).toEqual([{ OR: [{ code: c }, { order: { code: c } }, { order: { customer: { name: c } } }] }]);
  });
});

describe("summarize", () => {
  it("summary_givenTwoTrackingsSameOrder_thenOrderCountedOnce", () => {
    const s = summarize(
      [{ orderId: "o1", packedAt: null }, { orderId: "o1", packedAt: new Date() }, { orderId: "o2", packedAt: null }],
      [{ qty: 2, unitPriceJpy: "1000" }, { qty: 1, unitPriceJpy: "500.5" }],
    );
    expect(s).toEqual({ trackings: 3, orders: 2, unpacked: 2, amountJpy: 2500.5 });
  });

  it("summary_givenEmpty_thenZeros", () => {
    expect(summarize([], [])).toEqual({ trackings: 0, orders: 0, unpacked: 0, amountJpy: 0 });
  });
});

describe("toPendingItem", () => {
  it("row_givenTrackingWithOrder_thenFlatRowWithAmount", () => {
    const row = toPendingItem({
      id: "t1", code: "WRONG1", status: "linked", packedAt: null, jpName: null, createdAt: new Date("2026-06-02T00:00:00Z"),
      order: {
        id: "o1", code: "JA100", orderDate: new Date("2026-06-01T03:00:00Z"), status: "purchased",
        customer: { name: "Khach A" },
        items: [{ name: "Ao", qty: 2, unitPriceJpy: "1500" as never }],
      },
    } as never);
    expect(row).toEqual({
      trackingId: "t1", trackingCode: "WRONG1", trackingStatus: "linked", packedAt: null, jpName: null,
      orderId: "o1", orderCode: "JA100", orderDate: "2026-06-01T03:00:00.000Z", orderStatus: "purchased",
      customerName: "Khach A", items: [{ name: "Ao", qty: 2, unitPriceJpy: 1500 }], amountJpy: 3000,
    });
  });

  it("amount_givenDecimalStrings_thenSummed", () => {
    expect(orderAmountJpy([{ qty: 3, unitPriceJpy: "10.5" }])).toBe(31.5);
  });
});
