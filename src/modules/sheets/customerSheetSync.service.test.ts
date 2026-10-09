import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake in-memory spreadsheet thay cho wrapper googleSheets.client (không gọi Google thật).
// Giữ nguyên helper thuần (colLetter, backgroundRequest, numberFormatRequest, protectedRangeRequest).
type FakeTab = { grid: string[][]; sheetId: number | null };
const fake = vi.hoisted(() => ({ tabs: new Map<string, { grid: string[][]; sheetId: number | null }>() }));

vi.mock("../../integrations/google/googleSheets.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/google/googleSheets.client.js")>();
  const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
  return {
    ...actual,
    listSheetTitles: vi.fn(async () => [...fake.tabs.keys()]),
    ensureSheetTab: vi.fn(async (_sid: string, title: string) => {
      if (!fake.tabs.has(title)) fake.tabs.set(title, { grid: [], sheetId: 99 });
    }),
    getSheetIdByTitle: vi.fn(async (_sid: string, title: string) => fake.tabs.get(title)?.sheetId ?? null),
    getValues: vi.fn(async (_sid: string, tab: string, a1: string) => {
      const grid = fake.tabs.get(tab)?.grid ?? [];
      const rowOnly = a1.match(/^(\d+):\d+$/);
      if (rowOnly) return [grid[Number(rowOnly[1]) - 1] ?? []];
      const colA = a1.match(/^A1:A(\d+)$/);
      if (colA) return grid.slice(0, Number(colA[1])).map((r) => [r?.[0] ?? ""]);
      const block = a1.match(/^A1:AZ(\d+)$/);
      if (block) return grid.slice(0, Number(block[1])).map((r) => r ?? []);
      throw new Error(`unexpected getValues range ${a1}`);
    }),
    updateValues: vi.fn(async (_sid: string, tab: string, a1: string, body: { values: unknown[][]; majorDimension?: string }) => {
      if (body.majorDimension === "COLUMNS") return {};
      const m = a1.match(/^([A-Z]+)(\d+)/);
      const t = fake.tabs.get(tab);
      if (!m || !t) return {};
      const c0 = colIndex(m[1]);
      body.values.forEach((row, i) => {
        const r = Number(m[2]) - 1 + i;
        t.grid[r] = t.grid[r] ?? [];
        row.forEach((v, j) => { t.grid[r][c0 + j] = String(v); });
      });
      return {};
    }),
    clearValues: vi.fn(async () => ({})),
    batchUpdate: vi.fn(async () => {}),
    getSpreadsheet: vi.fn(async () => ({ sheets: [{ properties: { sheetId: 7 }, protectedRanges: [] }] })),
    sleep: vi.fn(async () => {}),
  };
});

vi.mock("../../integrations/google/googleAuth.js", () => ({
  serviceAccountEnabled: vi.fn(() => true),
  serviceAccountEmail: vi.fn(() => "sa@test.iam.gserviceaccount.com"),
}));

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    customer: { findUnique: vi.fn() },
    order: { findMany: vi.fn() },
    customerDeposit: { findMany: vi.fn() },
    companyCost: { findMany: vi.fn() },
    carton: { findMany: vi.fn() },
  },
}));

vi.mock("../../infrastructure/systemLog.js", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { syncCustomerOrders } from "./customerSheetSync.service.js";
import * as client from "../../integrations/google/googleSheets.client.js";
import * as auth from "../../integrations/google/googleAuth.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logError, logWarn } from "../../infrastructure/systemLog.js";

const mClient = vi.mocked(client);
const mAuth = vi.mocked(auth);
const mPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn> };
  order: { findMany: ReturnType<typeof vi.fn> };
  customerDeposit: { findMany: ReturnType<typeof vi.fn> };
  companyCost: { findMany: ReturnType<typeof vi.fn> };
  carton: { findMany: ReturnType<typeof vi.fn> };
};

// Tiêu đề A..V: bố cục cũ A..N + các cột khách tự thêm O..U + "Số tiền giảm giá" ở V.
const FULL_HEADER = [
  "Mã Link", "Ngày đặt", "ACC", "LINK đặt", "Phương thức thanh toán", "GIÁ WEB", "SHIP WEB",
  "% Công", "Tổng tiền bao gồm tiền công", "Cân-Kg", "Phụ thu", "TRACKING", "Đánh giá", "Ngày giao cho khách hàng",
  "tỉ giá", "Tổng tiền KH quy đổi VND", "Đơn giá vận chuyển", "Tổng tiền vận chuyển", "Tổng tiền VND+ Vận chuyển",
  "lưu kho", "tracking việt nam", "Số tiền giảm giá",
];

// 10:00 giờ VN ngày 15/03/2026
const MAR15 = new Date("2026-03-15T03:00:00Z");

const item = (o: Record<string, unknown> = {}) => ({
  qty: 1, unitPriceJpy: 1000, shipJpy: null, purchaseDate: MAR15, url: "https://shop/x", paymentMethod: "card", ...o,
});
const tracking = (o: Record<string, unknown> = {}) => ({
  id: "t1", code: "TRK00001", jpWeightKg: null, vnWeightKg: null, unitPriceVndPerKg: null, shipRateCurrency: "VND",
  review: null, deliveredAt: null, status: "pending", vnTrackingCode: null, cartonId: null, ...o,
});
const order = (o: Record<string, unknown> = {}) => ({
  id: "o1", code: "ORD1", nick: "acc1", createdAt: MAR15, exchangeRate: null,
  surchargeAmount: 0, surchargeCurrency: "VND", commissionPercent: 0, shipAmount: 0, shipCurrency: "JPY",
  discountAmount: 0, discountCurrency: "JPY", serviceFeeAmount: 0, serviceFeeCurrency: "JPY", serviceFeeCustomerPays: true,
  jpDomesticShipAmount: 0, jpDomesticShipCurrency: "JPY", intlShipAmount: 0, intlShipCurrency: "VND",
  items: [item()], trackings: [] as unknown[], payments: [], ...o,
});

function setup(opts: {
  customer?: Record<string, unknown> | null;
  orders?: unknown[];
  deposits?: unknown[];
  cod?: { refId: string; currency: string; amountOrig: number; amountVnd: number; exchangeRate: number | null }[];
  cartons?: { id: string; route: string }[];
  tabs?: Record<string, FakeTab>;
} = {}) {
  fake.tabs.clear();
  const tabs = opts.tabs ?? { "Tháng 3": { grid: [[...FULL_HEADER]], sheetId: 7 } };
  for (const [k, v] of Object.entries(tabs)) fake.tabs.set(k, v);
  mPrisma.customer.findUnique.mockResolvedValue(
    opts.customer === undefined ? { id: "c1", sheetId: "sid", shipRatePerKg: null } : opts.customer,
  );
  mPrisma.order.findMany.mockResolvedValue(opts.orders ?? []);
  mPrisma.customerDeposit.findMany.mockResolvedValue(opts.deposits ?? []);
  mPrisma.companyCost.findMany.mockResolvedValue(opts.cod ?? []);
  mPrisma.carton.findMany.mockResolvedValue(opts.cartons ?? []);
}

// Giá trị đã ghi vào 1 cột (theo chữ cái) của tab, bắt từ updateValues dạng ROWS.
function written(tab: string, letter: string): unknown[] | undefined {
  const call = mClient.updateValues.mock.calls.find(
    ([, t, a1, body]) => t === tab && new RegExp(`^${letter}\\d+$`).test(a1) && body.majorDimension === "ROWS",
  );
  return call?.[3].values.map((r) => r[0]);
}

function totalsWrite(tab: string) {
  return mClient.updateValues.mock.calls.find(([, t, a1]) => t === tab && a1 === "H1:H3")?.[3].values[0];
}

const allRequests = () => mClient.batchUpdate.mock.calls.flatMap(([, reqs]) => reqs as Record<string, any>[]);

beforeEach(() => {
  vi.clearAllMocks();
  mAuth.serviceAccountEnabled.mockReturnValue(true);
  mAuth.serviceAccountEmail.mockReturnValue("sa@test.iam.gserviceaccount.com");
});

describe("syncCustomerOrders - guards", () => {
  it("syncCustomerOrders_serviceAccountDisabled_doesNotQueryDbOrSheet", async () => {
    setup();
    mAuth.serviceAccountEnabled.mockReturnValue(false);

    await syncCustomerOrders("c1");

    expect(mPrisma.customer.findUnique).not.toHaveBeenCalled();
    expect(mClient.updateValues).not.toHaveBeenCalled();
  });

  it.each([
    ["customer not found", null],
    ["customer without sheet link", { id: "c1", sheetId: null, shipRatePerKg: null }],
  ])("syncCustomerOrders_%s_writesNothingToSheet", async (_name, customer) => {
    setup({ customer, orders: [order()] });

    await syncCustomerOrders("c1");

    expect(mClient.listSheetTitles).not.toHaveBeenCalled();
    expect(mClient.updateValues).not.toHaveBeenCalled();
  });
});

describe("syncCustomerOrders - rows per month", () => {
  it.each(["Tháng 3", "thang 03", "T3", "3"])(
    "syncCustomerOrders_existingMonthTabTitled_%s_writesIntoThatTabWithoutCreating",
    async (title) => {
      setup({ orders: [order()], tabs: { [title]: { grid: [[...FULL_HEADER]], sheetId: 7 } } });

      await syncCustomerOrders("c1");

      expect(written(title, "A")).toEqual(["ORD1"]);
      expect(mClient.ensureSheetTab).not.toHaveBeenCalled();
    },
  );

  it("syncCustomerOrders_itemInMonthWithoutTab_createsTabWritesTotalsLabelsAndHeaderAtRow5", async () => {
    setup({ orders: [order({ items: [item({ purchaseDate: new Date("2026-04-02T03:00:00Z") })] })], tabs: {} });

    await syncCustomerOrders("c1");

    expect(mClient.ensureSheetTab).toHaveBeenCalledWith("sid", "Tháng 4");
    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 4", "G1:G3", { majorDimension: "COLUMNS", values: [["TỔNG TT", "CỌC", "NỢ"]] });
    expect(mClient.updateValues.mock.calls.find(([, t, a1]) => t === "Tháng 4" && a1 === "A1")).toBeUndefined();
    const header = mClient.updateValues.mock.calls.find(([, t, a1]) => t === "Tháng 4" && a1 === "A5")?.[3].values[0];
    expect(header?.slice(0, 8)).toEqual(["Mã Link", "Ngày đặt", "ACC", "LINK đặt", "Phương thức thanh toán", "GIÁ WEB", "SHIP WEB", "Số tiền giảm giá"]);
    expect(header).toEqual(expect.arrayContaining([
      "tỉ giá", "Tổng tiền KH quy đổi VND", "Đơn giá vận chuyển", "Tổng tiền vận chuyển", "Phụ thu",
      "Tổng tiền VND+ Vận chuyển", "lưu kho", "tracking việt nam",
    ]));
    expect(header?.slice(-6)).toEqual(["", "Mã", "Ngày", "Tên khoản mục", "Nội dung", "Tiền"]);
    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 4", "A6", { majorDimension: "ROWS", values: [["ORD1"]] });
  });

  it("syncCustomerOrders_newTabWithDeposit_writesDepositRowsUnderTemplateBlock", async () => {
    setup({
      deposits: [{ paidAt: new Date("2026-04-03T03:00:00Z"), note: "CK", amountVnd: 100000, amountOrig: 100000, currency: "VND" }],
      tabs: {},
    });

    await syncCustomerOrders("c1");

    const call = mClient.updateValues.mock.calls.find(([, t, , body]) => t === "Tháng 4" && body.values[0]?.[1] === "Thu tiền hàng");
    expect(call?.[2]).toMatch(/^[A-Z]+6$/);
    expect(call?.[3].values).toEqual([["03/04/2026", "Thu tiền hàng", "CK", 100000]]);
  });

  it("syncCustomerOrders_itemsOfOneOrderInDifferentMonths_splitsByEachItemPurchaseDate", async () => {
    setup({
      orders: [order({ items: [item(), item({ purchaseDate: new Date("2026-04-02T03:00:00Z") })] })],
      tabs: {
        "Tháng 3": { grid: [[...FULL_HEADER]], sheetId: 7 },
        "Tháng 4": { grid: [[...FULL_HEADER]], sheetId: 8 },
      },
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "A")).toEqual(["ORD1.1"]);
    expect(written("Tháng 4", "A")).toEqual(["ORD1.2"]);
  });

  it("syncCustomerOrders_purchaseAt23hUtcLastDayOfMonth_bucketsIntoNextMonthByVnTime", async () => {
    // 2026-03-31T18:00Z = 01:00 ngày 01/04 giờ VN
    setup({
      orders: [order({ items: [item({ purchaseDate: new Date("2026-03-31T18:00:00Z") })] })],
      tabs: { "Tháng 4": { grid: [[...FULL_HEADER]], sheetId: 8 } },
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 4", "B")).toEqual(["01/04/2026"]);
  });

  it("syncCustomerOrders_itemWithoutPurchaseDate_fallsBackToOrderCreatedAt", async () => {
    setup({ orders: [order({ createdAt: new Date("2026-03-20T03:00:00Z"), items: [item({ purchaseDate: null })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "B")).toEqual(["20/03/2026"]);
  });

  it("syncCustomerOrders_rowsInSameMonth_sortedByPurchaseDateAscending", async () => {
    setup({
      orders: [
        order({ code: "LATE", items: [item({ purchaseDate: new Date("2026-03-20T03:00:00Z") })] }),
        order({ code: "EARLY", items: [item({ purchaseDate: new Date("2026-03-05T03:00:00Z") })] }),
      ],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "A")).toEqual(["EARLY", "LATE"]);
  });

  it("syncCustomerOrders_existingMonthTabWithNoMoreData_clearsColumnsWithoutWritingRows", async () => {
    setup({ orders: [], tabs: { "Tháng 3": { grid: [[...FULL_HEADER]], sheetId: 7 } } });

    await syncCustomerOrders("c1");

    expect(mClient.clearValues).toHaveBeenCalledWith("sid", "Tháng 3", "A2:A100000");
    expect(written("Tháng 3", "A")).toBeUndefined();
  });

  it("syncCustomerOrders_headerOnRow3_writesDataStartingRow4", async () => {
    setup({
      orders: [order()],
      tabs: { "Tháng 3": { grid: [["TỔNG"], [""], [...FULL_HEADER]], sheetId: 7 } },
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "A4", { majorDimension: "ROWS", values: [["ORD1"]] });
  });

  it("syncCustomerOrders_mãLinkHeaderNotInColumnA_writesUnderFoundHeaderWithoutTemplate", async () => {
    setup({
      orders: [order({ code: "ORDX" })],
      tabs: { "Tháng 3": { grid: [["Ghi chú riêng", "Mã Link"]], sheetId: 7 } },
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues.mock.calls.find(([, , a1]) => a1 === "A1")).toBeUndefined();
    expect(written("Tháng 3", "B")).toEqual(["ORDX"]);
  });

  it("syncCustomerOrders_tabHasContentButNoHeader_writesNothingToTab", async () => {
    setup({
      orders: [order({ code: "ORDX" })],
      tabs: { "Tháng 3": { grid: [["Ghi chú riêng"], ["dữ liệu khách"]], sheetId: 7 } },
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues.mock.calls.filter(([, t]) => t === "Tháng 3")).toEqual([]);
    expect(mClient.clearValues.mock.calls.filter(([, t]) => t === "Tháng 3")).toEqual([]);
    expect(logWarn).toHaveBeenCalledWith({ tab: "Tháng 3" }, "gsheets_customer_tab_header_missing_skipped");
  });

  it("syncCustomerOrders_sameMonthTwoYears_laterYearGoesToOwnYearTab", async () => {
    setup({
      orders: [
        order({ id: "o1", code: "OLD", items: [item({ purchaseDate: new Date("2025-03-10T03:00:00Z") })] }),
        order({ id: "o2", code: "NEW", items: [item({ purchaseDate: MAR15 })] }),
      ],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "A")).toEqual(["OLD"]);
    expect(written("Tháng 3/2026", "A")).toEqual(["NEW"]);
  });

  it("syncCustomerOrders_jpySurchargeWithoutRate_keepsYenAmount", async () => {
    setup({ orders: [order({ exchangeRate: null, surchargeAmount: 1500, surchargeCurrency: "JPY" })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "K")).toEqual(["¥1,500"]);
  });

  it("syncCustomerOrders_customColumnShiftsTracking_writesTrackingUnderItsHeader", async () => {
    setup({
      orders: [order({ trackings: [tracking({ code: "TRK12345" })] })],
      tabs: { "Tháng 3": { grid: [["Mã Link", "Cột riêng", "TRACKING"]], sheetId: 7 } },
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "C")).toEqual(["TRK12345"]);
    expect(written("Tháng 3", "B")).toBeUndefined();
  });

  it("syncCustomerOrders_commissionColumn_isNeverWrittenOrCleared", async () => {
    setup({ orders: [order({ commissionPercent: 10 })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "H")).toBeUndefined();
    expect(mClient.clearValues.mock.calls.some(([, , a1]) => a1.startsWith("H2:"))).toBe(false);
  });
});

describe("syncCustomerOrders - row values", () => {
  it("syncCustomerOrders_multiItemOrder_suffixesCodeWithItemIndex", async () => {
    setup({ orders: [order({ items: [item(), item()] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "A")).toEqual(["ORD1.1", "ORD1.2"]);
  });

  it("syncCustomerOrders_commissionPercent_totalIncludesCommissionOnPriceAndItemShip", async () => {
    setup({ orders: [order({ commissionPercent: 10, items: [item({ qty: 2, unitPriceJpy: 1000, shipJpy: 200 })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "F")).toEqual([2000]);
    expect(written("Tháng 3", "I")).toEqual([2420]);
  });

  it("syncCustomerOrders_withExchangeRate_writesRateAndRoundedVndConverted", async () => {
    setup({ orders: [order({ exchangeRate: "170.5", items: [item({ unitPriceJpy: 1001 })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "O")).toEqual([170.5]);
    expect(written("Tháng 3", "P")).toEqual([170671]);
  });

  it("syncCustomerOrders_noExchangeRate_leavesRateAndVndBlank", async () => {
    setup({ orders: [order()] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "O")).toEqual([""]);
    expect(written("Tháng 3", "P")).toEqual([""]);
  });

  it.each([
    ["item ship + order ship JPY", 500, 300, "=500+300"],
    ["only order ship JPY", null, 300, 300],
    ["only item ship", 500, 0, 500],
    ["no ship at all", null, 0, ""],
  ])("syncCustomerOrders_%s_shipCellFormat", async (_name, itemShip, orderShip, expected) => {
    setup({ orders: [order({ shipAmount: orderShip, shipCurrency: "JPY", items: [item({ shipJpy: itemShip })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "G")).toEqual([expected]);
  });

  it("syncCustomerOrders_orderShipJpyOnMultiItemOrder_addedToFirstItemOnly", async () => {
    setup({ orders: [order({ shipAmount: 300, shipCurrency: "JPY", items: [item(), item()] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "G")).toEqual([300, ""]);
    expect(written("Tháng 3", "I")).toEqual([1300, 1000]);
  });

  it("syncCustomerOrders_orderShipInVnd_addedToVndConvertedNotShipCell", async () => {
    setup({ orders: [order({ exchangeRate: 170, shipAmount: 30000, shipCurrency: "VND" })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "G")).toEqual([""]);
    expect(written("Tháng 3", "P")).toEqual([200000]);
  });

  it("syncCustomerOrders_surchargeInJpy_convertedByRateOnFirstItemOnly", async () => {
    setup({ orders: [order({ exchangeRate: 170, surchargeAmount: 100, surchargeCurrency: "JPY", items: [item(), item()] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "K")).toEqual([17000, ""]);
  });

  it("syncCustomerOrders_codReportedForTracking_addedToSurchargeOfThatRow", async () => {
    setup({
      orders: [order({
        surchargeAmount: 5000, surchargeCurrency: "VND",
        items: [item(), item()],
        trackings: [tracking({ id: "tA" }), tracking({ id: "tB", code: "TRK00002" })],
      })],
      cod: [{ refId: "tB", currency: "VND", amountOrig: 12000, amountVnd: 12000, exchangeRate: null }],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "K")).toEqual([5000, 12000]);
  });

  it("syncCustomerOrders_noTrackings_doesNotQueryCod", async () => {
    setup({ orders: [order()] });

    await syncCustomerOrders("c1");

    expect(mPrisma.companyCost.findMany).not.toHaveBeenCalled();
    expect(mPrisma.carton.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["vn weight preferred over jp", 1.2, 0.8, 0.8],
    ["only jp weight", 1.2, null, 1.2],
    ["no weight", null, null, ""],
  ])("syncCustomerOrders_%s_weightCell", async (_name, jp, vn, expected) => {
    setup({ orders: [order({ trackings: [tracking({ jpWeightKg: jp, vnWeightKg: vn })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "J")).toEqual([expected]);
  });

  it("syncCustomerOrders_trackingRateInJpy_convertsRateAndShipTotalByExchangeRate", async () => {
    setup({
      orders: [order({ exchangeRate: 170, trackings: [tracking({ vnWeightKg: 2, unitPriceVndPerKg: 1000, shipRateCurrency: "JPY" })] })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "Q")).toEqual([170000]);
    expect(written("Tháng 3", "R")).toEqual([340000]);
  });

  it("syncCustomerOrders_trackingWithoutRateButStaleJpyFlag_usesCustomerVndRateUnconverted", async () => {
    setup({
      customer: { id: "c1", sheetId: "sid", shipRatePerKg: 150000 },
      orders: [order({ exchangeRate: 170, trackings: [tracking({ vnWeightKg: 2, unitPriceVndPerKg: null, shipRateCurrency: "JPY" })] })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "Q")).toEqual([150000]);
    expect(written("Tháng 3", "R")).toEqual([300000]);
  });

  it("syncCustomerOrders_rateAndShip_grandTotalIsVndPlusRoundedShip", async () => {
    setup({
      orders: [order({ exchangeRate: 170, trackings: [tracking({ vnWeightKg: 1.5, unitPriceVndPerKg: 100001 })] })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "S")).toEqual([320002]);
  });

  it.each([
    ["stored and not shipped", "stored", null, "lưu kho"],
    ["stored but has VN tracking", "stored", "VN123", ""],
    ["not stored", "pending", null, ""],
  ])("syncCustomerOrders_%s_storedCell", async (_name, status, vnCode, expected) => {
    setup({ orders: [order({ trackings: [tracking({ status, vnTrackingCode: vnCode })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "T")).toEqual([expected]);
  });

  it("syncCustomerOrders_deliveredTracking_writesDeliveredDateInVnTime", async () => {
    setup({ orders: [order({ trackings: [tracking({ deliveredAt: new Date("2026-03-15T20:00:00Z") })] })] });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "N")).toEqual(["16/03/2026"]);
  });
});

describe("syncCustomerOrders - colors", () => {
  const bgOf = (r: Record<string, any>) => r.repeatCell?.cell?.userEnteredFormat?.backgroundColor;
  const paintAt = (row: number, col: number) =>
    allRequests().filter((r) => r.repeatCell?.range?.startRowIndex === row && r.repeatCell?.range?.endRowIndex === row + 1 && r.repeatCell?.range?.startColumnIndex === col);

  it("syncCustomerOrders_storedRow_paintsStoredCellOrange", async () => {
    setup({ orders: [order({ trackings: [tracking({ status: "stored" })] })] });

    await syncCustomerOrders("c1");

    // cột T = index 19, dòng data đầu = rowIndex 1
    expect(paintAt(1, 19).map(bgOf)).toEqual([{ red: 1, green: 0.85, blue: 0.6 }]);
  });

  it("syncCustomerOrders_statusColumnsPresent_resetsWholeColumnToWhiteFirst", async () => {
    setup({ orders: [order()] });

    await syncCustomerOrders("c1");

    const reset = allRequests().find((r) => r.repeatCell?.range?.startColumnIndex === 19 && r.repeatCell?.range?.endRowIndex === 501);
    expect(bgOf(reset!)).toEqual({ red: 1, green: 1, blue: 1 });
  });

  it.each([
    ["15/03/2026", "2026-03-15T03:00:00Z", { red: 1, green: 0.8, blue: 0.85 }],
    ["16/03/2026", "2026-03-16T03:00:00Z", { red: 0.88, green: 0.8, blue: 0.95 }],
    ["20/03/2026", "2026-03-20T03:00:00Z", { red: 1, green: 0.95, blue: 0.6 }],
  ])("syncCustomerOrders_deliveredOn_%s_paintsDeliveredCellWithStableDateColor", async (_d, iso, color) => {
    setup({ orders: [order({ trackings: [tracking({ deliveredAt: new Date(iso) })] })] });

    await syncCustomerOrders("c1");

    // cột N = index 13
    expect(paintAt(1, 13).map(bgOf)).toEqual([color]);
  });

  it("syncCustomerOrders_notDelivered_doesNotPaintDeliveredCell", async () => {
    setup({ orders: [order({ trackings: [tracking()] })] });

    await syncCustomerOrders("c1");

    expect(paintAt(1, 13)).toEqual([]);
  });

  it("syncCustomerOrders_tabWithoutStatusColumns_sendsNoPaintRequests", async () => {
    setup({ orders: [order()], tabs: { "Tháng 3": { grid: [["Mã Link", "TRACKING"]], sheetId: 7 } } });

    await syncCustomerOrders("c1");

    expect(allRequests().some((r) => bgOf(r))).toBe(false);
  });
});

describe("syncCustomerOrders - deposits", () => {
  // Sổ cọc ở dòng 5, cột X..AA (Ngày | Tên khoản mục | Nội dung | Tiền)
  const withDepositBlock = (): FakeTab => {
    const grid: string[][] = [[...FULL_HEADER], [], [], [], []];
    grid[4][22] = "Mã"; grid[4][23] = "Ngày"; grid[4][24] = "Tên khoản mục"; grid[4][25] = "Nội dung"; grid[4][26] = "Tiền";
    return { grid, sheetId: 7 };
  };
  const dep = (o: Record<string, unknown> = {}) => ({
    paidAt: new Date("2026-03-10T03:00:00Z"), note: "CK lần 1", amountVnd: 500000, amountOrig: 500000, currency: "VND", ...o,
  });

  it("syncCustomerOrders_depositInMonth_writesDepositRowUnderDetectedHeader", async () => {
    setup({ deposits: [dep()], tabs: { "Tháng 3": withDepositBlock() } });

    await syncCustomerOrders("c1");

    expect(mClient.clearValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6:AA100000");
    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6", { values: [["10/03/2026", "Thu tiền hàng", "CK lần 1", 500000]] });
  });

  it("syncCustomerOrders_noDepositsInMonth_clearsDepositBlockOnly", async () => {
    setup({ orders: [order()], tabs: { "Tháng 3": withDepositBlock() } });

    await syncCustomerOrders("c1");

    expect(mClient.clearValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6:AA100000");
    expect(mClient.updateValues.mock.calls.some(([, , a1]) => a1 === "X6")).toBe(false);
  });

  it("syncCustomerOrders_depositInMonthWithoutTab_createsMonthTab", async () => {
    setup({ deposits: [dep({ paidAt: new Date("2026-05-10T03:00:00Z") })], tabs: {} });

    await syncCustomerOrders("c1");

    expect(mClient.ensureSheetTab).toHaveBeenCalledWith("sid", "Tháng 5");
  });

  it("syncCustomerOrders_tabWithoutDepositHeader_writesNoDepositRows", async () => {
    setup({ deposits: [dep()] });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues.mock.calls.some(([, , , body]) => body.values[0]?.[1] === "Thu tiền hàng")).toBe(false);
  });

  it("syncCustomerOrders_nullNote_writesEmptyContent", async () => {
    setup({ deposits: [dep({ note: null })], tabs: { "Tháng 3": withDepositBlock() } });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6", { values: [["10/03/2026", "Thu tiền hàng", "", 500000]] });
  });
});

describe("syncCustomerOrders - totals H1:H3", () => {
  const formatPattern = () =>
    allRequests().find((r) => r.repeatCell?.cell?.userEnteredFormat?.numberFormat)?.repeatCell.cell.userEnteredFormat.numberFormat.pattern;

  it("syncCustomerOrders_withExchangeRate_writesVndTotalsAgainstVndDeposits", async () => {
    setup({
      orders: [order({ exchangeRate: 170 })],
      deposits: [
        { paidAt: MAR15, note: null, amountVnd: 50000, amountOrig: 50000, currency: "VND" },
        { paidAt: MAR15, note: null, amountVnd: 17000, amountOrig: 100, currency: "JPY" },
      ],
    });

    await syncCustomerOrders("c1");

    // Cọc ¥ của khách ₫ tính theo amountVnd vào cột ₫
    expect(totalsWrite("Tháng 3")).toEqual([170000, 67000, 103000]);
    expect(formatPattern()).toBe("#,##0 \"₫\"");
  });

  it("syncCustomerOrders_noExchangeRate_writesJpyTotalsAgainstJpyDeposits", async () => {
    setup({
      orders: [order()],
      deposits: [
        { paidAt: MAR15, note: null, amountVnd: 50000, amountOrig: 50000, currency: "VND" },
        { paidAt: MAR15, note: null, amountVnd: 17000, amountOrig: 300, currency: "JPY" },
      ],
    });

    await syncCustomerOrders("c1");

    expect(totalsWrite("Tháng 3")).toEqual([1000, 300, 700]);
    expect(formatPattern()).toBe("\"¥\"#,##0");
  });

  it("syncCustomerOrders_emptyMonth_writesBlankTotals", async () => {
    setup();

    await syncCustomerOrders("c1");

    expect(totalsWrite("Tháng 3")).toEqual(["", "", ""]);
  });

  it("syncCustomerOrders_always_clearsLegacyTotalsCellsI1J3", async () => {
    setup({ orders: [order()] });

    await syncCustomerOrders("c1");

    expect(mClient.clearValues).toHaveBeenCalledWith("sid", "Tháng 3", "I1:J3");
  });

  it("syncCustomerOrders_tabSheetIdUnknown_skipsNumberFormatAndProtection", async () => {
    setup({ orders: [order()], tabs: { "Tháng 3": { grid: [[...FULL_HEADER]], sheetId: null } } });

    await syncCustomerOrders("c1");

    expect(mClient.batchUpdate).not.toHaveBeenCalled();
  });
});

describe("syncCustomerOrders - protected ranges", () => {
  const protectDescs = () => allRequests().filter((r) => r.addProtectedRange).map((r) => r.addProtectedRange.protectedRange.description);

  it("syncCustomerOrders_newTab_protectsManagedColumnsAndTotalsForServiceAccount", async () => {
    setup({ orders: [order()], tabs: { "Tháng 3": { grid: [["Mã Link", "TRACKING"]], sheetId: 7 } } });

    await syncCustomerOrders("c1");

    expect(protectDescs()).toEqual(["sys:code", "sys:tracking", "sys:total"]);
    const req = allRequests().find((r) => r.addProtectedRange?.protectedRange.description === "sys:tracking");
    expect(req!.addProtectedRange.protectedRange.range).toEqual({ sheetId: 7, startRowIndex: 0, endRowIndex: 100000, startColumnIndex: 1, endColumnIndex: 2 });
    expect(req!.addProtectedRange.protectedRange.editors).toEqual({ users: ["sa@test.iam.gserviceaccount.com"] });
  });

  it("syncCustomerOrders_rangesAlreadyProtected_doesNotAddDuplicates", async () => {
    setup({ orders: [order()], tabs: { "Tháng 3": { grid: [["Mã Link", "TRACKING"]], sheetId: 7 } } });
    mClient.getSpreadsheet.mockResolvedValueOnce({
      sheets: [{ properties: { sheetId: 7 }, protectedRanges: [{ description: "sys:code" }, { description: "sys:total" }] }],
    });

    await syncCustomerOrders("c1");

    expect(protectDescs()).toEqual(["sys:tracking"]);
  });

  it("syncCustomerOrders_noServiceAccountEmail_addsNoProtection", async () => {
    setup({ orders: [order()] });
    mAuth.serviceAccountEmail.mockReturnValue(undefined);

    await syncCustomerOrders("c1");

    expect(protectDescs()).toEqual([]);
  });

  it("syncCustomerOrders_protectMetadataFails_logsAndStillWritesTotals", async () => {
    setup({ orders: [order()] });
    mClient.getSpreadsheet.mockRejectedValueOnce(new Error("403"));

    await syncCustomerOrders("c1");

    expect(logError).toHaveBeenCalledWith({ err: "403" }, "gsheets_protect_managed_ranges_failed");
    expect(totalsWrite("Tháng 3")).toEqual([1000, "", 1000]);
  });
});

describe("syncCustomerOrders - retry and serialization", () => {
  it("syncCustomerOrders_transientSheetError_retriesOnceAfter3sAndWrites", async () => {
    setup({ orders: [order()] });
    mClient.listSheetTitles.mockRejectedValueOnce(new Error("500"));

    await syncCustomerOrders("c1");

    expect(logWarn).toHaveBeenCalledWith({ err: "500" }, "gsheets_sync_customer_orders_retry");
    expect(mClient.sleep).toHaveBeenCalledWith(3000);
    expect(written("Tháng 3", "A")).toEqual(["ORD1"]);
  });

  it("syncCustomerOrders_errorOnBothAttempts_logsFailureAndResolvesWithoutThrowing", async () => {
    setup({ orders: [order()] });
    mClient.listSheetTitles.mockRejectedValueOnce(new Error("500")).mockRejectedValueOnce(new Error("503"));

    await expect(syncCustomerOrders("c1")).resolves.toBeUndefined();

    expect(logError).toHaveBeenCalledWith({ err: "503" }, "gsheets_sync_customer_orders_failed");
    expect(mPrisma.customer.findUnique).toHaveBeenCalledTimes(2);
  });

  it("syncCustomerOrders_twoCallsSameCustomer_secondWaitsForFirst", async () => {
    setup();
    let release!: () => void;
    mPrisma.customer.findUnique.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));

    const p1 = syncCustomerOrders("c1");
    const p2 = syncCustomerOrders("c1");
    await new Promise((r) => setImmediate(r));
    expect(mPrisma.customer.findUnique).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([p1, p2]);
    expect(mPrisma.customer.findUnique).toHaveBeenCalledTimes(2);
  });

  it("syncCustomerOrders_callsForDifferentCustomers_runConcurrently", async () => {
    setup();
    let release!: () => void;
    mPrisma.customer.findUnique.mockImplementationOnce(() => new Promise((r) => { release = () => r(null); }));

    const p1 = syncCustomerOrders("c1");
    const p2 = syncCustomerOrders("c2");
    await new Promise((r) => setImmediate(r));
    expect(mPrisma.customer.findUnique).toHaveBeenCalledTimes(2);

    release();
    await Promise.all([p1, p2]);
  });
});

describe("syncCustomerOrders - discount, commission and order fees", () => {
  it("syncCustomerOrders_jpyDiscount_subtractedOnFirstItemBeforeCommission", async () => {
    setup({
      orders: [order({
        commissionPercent: 10, discountAmount: 200, discountCurrency: "JPY",
        items: [item({ shipJpy: 200 }), item()],
      })],
    });

    await syncCustomerOrders("c1");

    // món 1: (1000+200-200) x 10% = 100 -> 1000+200-200+100; món 2: 1000 + 100
    expect(written("Tháng 3", "V")).toEqual([200, ""]);
    expect(written("Tháng 3", "I")).toEqual([1100, 1100]);
  });

  it("syncCustomerOrders_orderLevelJpyFees_mergedIntoFirstItemShipFormulaAndTotal", async () => {
    setup({
      orders: [order({
        exchangeRate: 170, shipAmount: 0,
        serviceFeeAmount: 300, serviceFeeCurrency: "JPY", jpDomesticShipAmount: 100, jpDomesticShipCurrency: "JPY",
        intlShipAmount: 50000, intlShipCurrency: "VND", discountAmount: 10000, discountCurrency: "VND",
        items: [item({ shipJpy: 500 }), item()],
      })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "G")).toEqual(["=500+400", ""]);
    expect(written("Tháng 3", "I")).toEqual([1900, 1000]);
    // 1900 x 170 + 50000 (ship quốc tế ₫) - 10000 (giảm giá ₫)
    expect(written("Tháng 3", "P")).toEqual([363000, 170000]);
    expect(written("Tháng 3", "V")).toEqual(["", ""]);
  });

  it("syncCustomerOrders_serviceFeeNotPaidByCustomer_excludedFromShipCell", async () => {
    setup({
      orders: [order({
        serviceFeeAmount: 300, serviceFeeCurrency: "JPY", serviceFeeCustomerPays: false,
        jpDomesticShipAmount: 100, jpDomesticShipCurrency: "JPY", items: [item({ shipJpy: 500 })],
      })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "G")).toEqual(["=500+100"]);
    expect(written("Tháng 3", "I")).toEqual([1600]);
  });
});

describe("syncCustomerOrders - COD and ship rate", () => {
  it("syncCustomerOrders_jpyCodWithAndWithoutRate_vndCustomerWithOrderRate_allConvertedToVnd", async () => {
    setup({
      orders: [order({ exchangeRate: 170, trackings: [tracking({ id: "tA" })] })],
      cod: [
        { refId: "tA", currency: "JPY", amountOrig: 100, amountVnd: 17500, exchangeRate: 175 },
        { refId: "tA", currency: "JPY", amountOrig: 50, amountVnd: 0, exchangeRate: null },
      ],
    });

    await syncCustomerOrders("c1");

    // 17500 (₫ đã chốt) + 50 x 170
    expect(written("Tháng 3", "K")).toEqual([26000]);
  });

  it("syncCustomerOrders_jpyCodNoRateAndNoOrderRate_keepsYenPlusVndPart", async () => {
    setup({
      orders: [order({ trackings: [tracking({ id: "tA" })] })],
      cod: [
        { refId: "tA", currency: "JPY", amountOrig: 100, amountVnd: 17500, exchangeRate: 175 },
        { refId: "tA", currency: "JPY", amountOrig: 50, amountVnd: 0, exchangeRate: null },
      ],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "K")).toEqual(["¥50 + 17500"]);
  });

  it.each([
    ["sea", 50000, 100000],
    ["air", 150000, 300000],
  ])("syncCustomerOrders_cartonRoute_%s_usesMatchingCustomerRate", async (route, rate, total) => {
    setup({
      customer: { id: "c1", sheetId: "sid", shipRatePerKg: 150000, shipRateSeaPerKg: 50000 },
      orders: [order({ trackings: [tracking({ vnWeightKg: 2, cartonId: "k1" })] })],
      cartons: [{ id: "k1", route }],
    });

    await syncCustomerOrders("c1");

    expect(mPrisma.carton.findMany).toHaveBeenCalledWith({ where: { id: { in: ["k1"] } }, select: { id: true, route: true } });
    expect(written("Tháng 3", "Q")).toEqual([rate]);
    expect(written("Tháng 3", "R")).toEqual([total]);
  });

  it("syncCustomerOrders_seaCartonButNoSeaRate_fallsBackToAirRate", async () => {
    setup({
      customer: { id: "c1", sheetId: "sid", shipRatePerKg: 150000, shipRateSeaPerKg: null },
      orders: [order({ trackings: [tracking({ vnWeightKg: 1, cartonId: "k1" })] })],
      cartons: [{ id: "k1", route: "sea" }],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "Q")).toEqual([150000]);
  });

  it("syncCustomerOrders_monthVndTotal_includesShipAndVndSurchargePerRow", async () => {
    setup({
      orders: [order({
        exchangeRate: 170, surchargeAmount: 5000, surchargeCurrency: "VND",
        trackings: [tracking({ vnWeightKg: 1, unitPriceVndPerKg: 100000 })],
      })],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "S")).toEqual([270000]);
    expect(totalsWrite("Tháng 3")).toEqual([275000, "", 275000]);
  });

  it("syncCustomerOrders_mixedRateAndNoRateRows_jpyTotalOnlyCountsRowsWithoutRate", async () => {
    setup({
      orders: [
        order({ id: "o1", code: "A", exchangeRate: null, items: [item({ unitPriceJpy: 700 })] }),
        order({ id: "o2", code: "B", exchangeRate: null, items: [item({ unitPriceJpy: 300 })] }),
      ],
      deposits: [{ paidAt: MAR15, note: null, amountVnd: 0, amountOrig: 400, currency: "JPY" }],
    });

    await syncCustomerOrders("c1");

    expect(totalsWrite("Tháng 3")).toEqual([1000, 400, 600]);
  });
});

describe("syncCustomerOrders - JPY-paying customer", () => {
  const jpyCustomer = { id: "c1", sheetId: "sid", shipRatePerKg: 100000, payCurrency: "JPY" };
  const withDepositBlock = (): FakeTab => {
    const grid: string[][] = [[...FULL_HEADER], [], [], [], []];
    grid[4][22] = "Mã"; grid[4][23] = "Ngày"; grid[4][24] = "Tên khoản mục"; grid[4][25] = "Nội dung"; grid[4][26] = "Tiền";
    return { grid, sheetId: 7 };
  };

  it("syncCustomerOrders_jpyCustomer_rateBlankNoConversionAndCodKeptInYen", async () => {
    setup({
      customer: jpyCustomer,
      orders: [order({ exchangeRate: 170, trackings: [tracking({ id: "tA", vnWeightKg: 2 })] })],
      cod: [
        { refId: "tA", currency: "JPY", amountOrig: 300, amountVnd: 51000, exchangeRate: 170 },
        { refId: "tA", currency: "JPY", amountOrig: 500, amountVnd: 0, exchangeRate: null },
      ],
    });

    await syncCustomerOrders("c1");

    expect(written("Tháng 3", "O")).toEqual([""]);
    expect(written("Tháng 3", "P")).toEqual([""]);
    expect(written("Tháng 3", "K")).toEqual(["¥800"]);
    expect(written("Tháng 3", "Q")).toEqual([100000]);
    expect(written("Tháng 3", "R")).toEqual([200000]);
    expect(written("Tháng 3", "S")).toEqual([200000]);
  });

  it("syncCustomerOrders_jpyCustomer_writesYenAndVndTotalsInHAndIWithBothFormats", async () => {
    setup({
      customer: jpyCustomer,
      orders: [order({ trackings: [tracking({ id: "tA", vnWeightKg: 2 })] })],
      cod: [{ refId: "tA", currency: "JPY", amountOrig: 800, amountVnd: 0, exchangeRate: null }],
      deposits: [
        { paidAt: MAR15, note: null, amountVnd: 170000, amountOrig: 1000, currency: "JPY" },
        { paidAt: MAR15, note: null, amountVnd: 50000, amountOrig: 50000, currency: "VND" },
      ],
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "H1:I3", {
      majorDimension: "COLUMNS", values: [[1800, 1000, 800], [200000, 50000, 150000]],
    });
    expect(totalsWrite("Tháng 3")).toBeUndefined();
    expect(mClient.clearValues).toHaveBeenCalledWith("sid", "Tháng 3", "J1:J3");
    const formats = allRequests().filter((r) => r.repeatCell?.cell?.userEnteredFormat?.numberFormat && r.repeatCell.range.endRowIndex === 3);
    expect(formats.map((r) => [r.repeatCell.range.startColumnIndex, r.repeatCell.cell.userEnteredFormat.numberFormat.pattern])).toEqual([
      [7, "\"¥\"#,##0"], [8, "#,##0 \"₫\""],
    ]);
  });

  it("syncCustomerOrders_jpyCustomerDeposits_yenDepositWrittenInYenWithNote", async () => {
    setup({
      customer: jpyCustomer,
      deposits: [
        { paidAt: new Date("2026-03-10T03:00:00Z"), note: "CK", amountVnd: 170000, amountOrig: 1000, currency: "JPY" },
        { paidAt: new Date("2026-03-11T03:00:00Z"), note: "CK2", amountVnd: 50000, amountOrig: 50000, currency: "VND" },
      ],
      tabs: { "Tháng 3": withDepositBlock() },
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6", { values: [
      ["10/03/2026", "Thu tiền hàng", "CK (¥)", 1000],
      ["11/03/2026", "Thu tiền hàng", "CK2", 50000],
    ] });
  });

  it("syncCustomerOrders_vndCustomerYenDeposit_writtenAsVndAmountWithoutYenNote", async () => {
    setup({
      deposits: [{ paidAt: new Date("2026-03-10T03:00:00Z"), note: "CK", amountVnd: 170000, amountOrig: 1000, currency: "JPY" }],
      tabs: { "Tháng 3": withDepositBlock() },
    });

    await syncCustomerOrders("c1");

    expect(mClient.updateValues).toHaveBeenCalledWith("sid", "Tháng 3", "X6", { values: [["10/03/2026", "Thu tiền hàng", "CK", 170000]] });
  });
});
