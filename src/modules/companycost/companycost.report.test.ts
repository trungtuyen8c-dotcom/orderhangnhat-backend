import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    appConfig: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    tracking: { findMany: vi.fn() },
    carton: { findMany: vi.fn() },
    companyCost: { findMany: vi.fn() },
  },
}));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../accounting/accounting.repository.js", () => ({ lockOrder: vi.fn(), writeAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));

import { electronicsUnit, globalPrices, monthOrCurrent, reinforceUnit, report, setElectronicsUnit, setGlobalPrices, setReinforceUnit, settlement } from "./companycost.service.js";
import { prisma } from "../../infrastructure/prisma.js";

const mp = prisma as any;
const REINFORCE = "reinforce_price_vnd";
const ELECTRONICS = "electronics_price_vnd";
const AIR = "global_price_air_vnd";
const SEA = "global_price_sea_vnd";
const config = (values: Record<string, string>) => {
  mp.appConfig.findUnique.mockImplementation(async ({ where }: any) => (where.key in values ? { key: where.key, value: values[where.key] } : null));
  mp.appConfig.findMany.mockImplementation(async ({ where }: any) =>
    (where.key.in as string[]).filter((k) => k in values).map((k) => ({ key: k, value: values[k] })));
};

beforeEach(() => {
  vi.clearAllMocks();
  config({});
  mp.tracking.findMany.mockResolvedValue([]);
  mp.carton.findMany.mockResolvedValue([]);
  mp.companyCost.findMany.mockResolvedValue([]);
});

const entry = (over: Record<string, unknown>) => ({
  id: "e", kind: "other", amountVnd: "0", currency: "VND", amountOrig: "0", exchangeRate: null, note: null,
  paid: false, createdAt: new Date("2026-03-10T05:00:00Z"), lateAfterLock: false, refId: null, ...over,
});

describe("unit price getters/setters", () => {
  it("reinforceUnit_noConfig_defaults30000", async () => {
    expect(await reinforceUnit()).toBe(30000);
  });

  it("reinforceUnit_configured_returnsNumber", async () => {
    config({ [REINFORCE]: "45000" });
    expect(await reinforceUnit()).toBe(45000);
  });

  it("electronicsUnit_noConfig_defaultsZero", async () => {
    expect(await electronicsUnit()).toBe(0);
  });

  it("setReinforceUnit_any_upsertsStringValueUnderReinforceKey", async () => {
    expect(await setReinforceUnit(40000)).toEqual({ unit: 40000 });
    expect(mp.appConfig.upsert).toHaveBeenCalledWith({ where: { key: REINFORCE }, update: { value: "40000" }, create: { key: REINFORCE, value: "40000" } });
  });

  it("setElectronicsUnit_any_upsertsUnderElectronicsKey", async () => {
    await setElectronicsUnit(5000);
    expect(mp.appConfig.upsert).toHaveBeenCalledWith({ where: { key: ELECTRONICS }, update: { value: "5000" }, create: { key: ELECTRONICS, value: "5000" } });
  });
});

describe("globalPrices", () => {
  it("globalPrices_noneSet_returnsNulls", async () => {
    expect(await globalPrices()).toEqual({ air: null, sea: null });
  });

  it("globalPrices_airOnly_seaNull", async () => {
    config({ [AIR]: "95000" });
    expect(await globalPrices()).toEqual({ air: 95000, sea: null });
  });

  it("setGlobalPrices_numberUpsertsNullDeletesUndefinedSkips", async () => {
    await setGlobalPrices({ air: 90000, sea: null });
    expect(mp.appConfig.upsert).toHaveBeenCalledWith({ where: { key: AIR }, update: { value: "90000" }, create: { key: AIR, value: "90000" } });
    expect(mp.appConfig.deleteMany).toHaveBeenCalledWith({ where: { key: SEA } });
    vi.clearAllMocks();
    await setGlobalPrices({ sea: 40000 });
    expect(mp.appConfig.upsert).toHaveBeenCalledTimes(1);
    expect(mp.appConfig.deleteMany).not.toHaveBeenCalled();
  });
});

describe("monthOrCurrent", () => {
  it("monthOrCurrent_invalid_defaultsToCurrentVnMonth", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-02-28T20:00:00Z"));
    try {
      expect(monthOrCurrent("2026/03")).toBe("2026-03");
    } finally {
      vi.useRealTimers();
    }
  });

  it("monthOrCurrent_valid_returnsAsIs", () => {
    expect(monthOrCurrent("2025-11")).toBe("2025-11");
  });
});

describe("report", () => {
  it("report_trackingsOfNeedsCheckOrders_countsDistinctOrdersPackedInVnMonth", async () => {
    mp.tracking.findMany.mockResolvedValue([
      { orderId: "o1", packedAt: new Date("2026-03-05T05:00:00Z") },
      { orderId: "o1", packedAt: new Date("2026-03-06T05:00:00Z") },
      { orderId: "o2", packedAt: new Date("2026-02-28T17:00:00Z") },
      { orderId: "o3", packedAt: new Date("2026-02-28T16:59:59Z") },
      { orderId: null, packedAt: new Date("2026-03-05T05:00:00Z") },
    ]);
    const r = await report("2026-03");
    expect([r.reinforceCount, r.reinforceVnd]).toEqual([2, 60000]);
  });

  it("report_cartonsPackedInMonth_electronicsCountTimesUnit", async () => {
    config({ [ELECTRONICS]: "2000" });
    mp.carton.findMany.mockResolvedValue([
      { packedDate: new Date("2026-03-01T00:00:00Z"), electronicsCount: 3 },
      { packedDate: new Date("2026-03-31T00:00:00Z"), electronicsCount: null },
      { packedDate: new Date("2026-04-01T00:00:00Z"), electronicsCount: 10 },
    ]);
    const r = await report("2026-03");
    expect([r.electronicsCount, r.electronicsVnd]).toEqual([3, 6000]);
  });

  it("report_mixedEntries_totalsPaidUnpaidAndByKind", async () => {
    config({ [REINFORCE]: "1000", [ELECTRONICS]: "100" });
    mp.tracking.findMany.mockResolvedValue([{ orderId: "o1", packedAt: new Date("2026-03-05T05:00:00Z") }]);
    mp.carton.findMany.mockResolvedValue([{ packedDate: new Date("2026-03-02T00:00:00Z"), electronicsCount: 2 }]);
    mp.companyCost.findMany.mockResolvedValue([
      entry({ id: "a", kind: "weight", amountVnd: "5000", paid: true }),
      entry({ id: "b", kind: "weight", amountVnd: "3000" }),
      entry({ id: "c", kind: "other", amountVnd: "700", paid: true }),
    ]);
    const r = await report("2026-03");
    expect(r).toMatchObject({ totalVnd: 9900, paidVnd: 5700, unpaidVnd: 4200 });
    expect(r.byKind).toEqual({ reinforce: 1000, electronics: 200, globalWeight: 0, weight: 8000, other: 700 });
  });

  it("report_chakubaraiEntryWithTracking_exposesTrackingOrderAndCustomer", async () => {
    mp.companyCost.findMany.mockResolvedValue([entry({ kind: "chakubarai", refId: "t1" })]);
    mp.tracking.findMany.mockImplementation(async ({ where }: any) =>
      where.id ? [{ id: "t1", code: "JP123", order: { code: "OD1", customer: { name: "Lan" } } }] : []);
    const [e] = (await report("2026-03")).entries;
    expect(e).toMatchObject({ trackingCode: "JP123", orderCode: "OD1", customerName: "Lan", kindLabel: "着払い / DAIBIKI (kho ứng hộ)" });
  });

  it("report_entryWithoutTracking_trackingFieldsNull", async () => {
    mp.companyCost.findMany.mockResolvedValue([entry({ kind: "weight" })]);
    const [e] = (await report("2026-03")).entries;
    expect(e).toMatchObject({ trackingCode: null, orderCode: null, customerName: null, kindLabel: "Tiền cân tháng" });
  });

  it("report_unknownKind_labelFallsBackToKind", async () => {
    mp.companyCost.findMany.mockResolvedValue([entry({ kind: "legacy" })]);
    expect((await report("2026-03")).entries[0].kindLabel).toBe("legacy");
  });

  it("report_jpyEntry_exposesNumericRateAndOriginalAmount", async () => {
    mp.companyCost.findMany.mockResolvedValue([entry({ currency: "JPY", amountOrig: "1000", exchangeRate: "170.5", amountVnd: "170500" })]);
    expect((await report("2026-03")).entries[0]).toMatchObject({ amountOrig: 1000, exchangeRate: 170.5, amountVnd: 170500 });
  });
});

describe("report - payments, global weight, daibiki", () => {
  it("report_paymentEntries_countedAsTransferredAndReduceUnpaidNotCost", async () => {
    config({ [REINFORCE]: "0" });
    mp.companyCost.findMany.mockResolvedValue([
      entry({ id: "a", kind: "weight", amountVnd: "5000000" }),
      entry({ id: "b", kind: "other", amountVnd: "1000000", paid: true }),
      entry({ id: "p", kind: "payment", amountVnd: "3000000" }),
      entry({ id: "p2", kind: "payment", amountVnd: "500000", paid: true }),
    ]);
    const r = await report("2026-03");
    expect(r).toMatchObject({ totalVnd: 6000000, transferredVnd: 3500000, paidVnd: 4500000, unpaidVnd: 1500000 });
    expect(r.byKind).not.toHaveProperty("payment");
  });

  it("report_globalWeightByRoute_missingSeaPrice_flagsAndExcludesSea", async () => {
    config({ [REINFORCE]: "0", [AIR]: "100000" });
    mp.carton.findMany.mockResolvedValue([
      { id: "c1", code: "K1", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "10.5", electronicsCount: 0 },
      { id: "c2", code: "K2", route: "sea", packedDate: new Date("2026-03-03T00:00:00Z"), declaredWeightKg: "20", electronicsCount: 0 },
      { id: "c3", code: "K3", route: "air", packedDate: new Date("2026-03-04T00:00:00Z"), declaredWeightKg: null, electronicsCount: 0 },
      { id: "c4", code: "K4", route: "air", packedDate: new Date("2026-04-01T00:00:00Z"), declaredWeightKg: "99", electronicsCount: 0 },
    ]);
    const r = await report("2026-03");
    expect(r.globalWeight).toEqual({ airKg: 10.5, seaKg: 20, airPrice: 100000, seaPrice: null, airVnd: 1050000, seaVnd: null, missingPrice: true });
    expect(r.byKind.globalWeight).toBe(1050000);
    expect(r.totalVnd).toBe(1050000);
  });

  it("report_globalWeightBothPrices_sumsRoutesNoMissing", async () => {
    config({ [REINFORCE]: "0", [AIR]: "100000", [SEA]: "30000" });
    mp.carton.findMany.mockResolvedValue([
      { id: "c1", code: "K1", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "2", electronicsCount: 0 },
      { id: "c2", code: "K2", route: "sea", packedDate: new Date("2026-03-03T00:00:00Z"), declaredWeightKg: "10", electronicsCount: 0 },
    ]);
    const r = await report("2026-03");
    expect(r.globalWeight).toMatchObject({ airVnd: 200000, seaVnd: 300000, missingPrice: false });
    expect(r.totalVnd).toBe(500000);
  });

  it("report_jpyCodAndTopup_trackedInDaibikiLedgerNotVndTotal", async () => {
    config({ [REINFORCE]: "0" });
    mp.companyCost.findMany.mockResolvedValue([
      entry({ id: "a", kind: "chakubarai", currency: "JPY", amountOrig: "3000", amountVnd: "0" }),
      entry({ id: "b", kind: "chakubarai", currency: "JPY", amountOrig: "2000", amountVnd: "340000", exchangeRate: "170" }),
      entry({ id: "t", kind: "daibiki_topup", currency: "JPY", amountOrig: "4000", amountVnd: "0" }),
      entry({ id: "v", kind: "chakubarai", currency: "VND", amountOrig: "100000", amountVnd: "100000" }),
    ]);
    const r = await report("2026-03");
    expect(r.daibiki).toEqual({ codJpy: 5000, topupJpy: 4000, balanceJpy: 1000 });
    expect(r.totalVnd).toBe(100000);
    expect(r.byKind.chakubarai).toBe(100000);
  });
});

describe("settlement", () => {
  it("settlement_cartonsSameDay_groupedAndSortedByDate", async () => {
    mp.carton.findMany.mockResolvedValue([
      { id: "c1", route: "air", packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "10", vnTotalWeightKg: "9.5", electronicsCount: 1 },
      { id: "c2", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "4", vnTotalWeightKg: null, electronicsCount: null },
      { id: "c3", route: "air", packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "5", vnTotalWeightKg: "5", electronicsCount: 2 },
    ]);
    const r = await settlement("2026-03");
    expect(r.rows.map((x) => [x.date, x.declaredKg, x.vnKg, x.electronicsCount])).toEqual([
      ["2026-03-02", 4, 0, 0],
      ["2026-03-05", 15, 14.5, 3],
    ]);
  });

  it("settlement_floatWeights_roundedTo2Decimals", async () => {
    mp.carton.findMany.mockResolvedValue([
      { id: "c4", route: "air", packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "0.1", vnTotalWeightKg: "0.1", electronicsCount: 0 },
      { id: "c5", route: "air", packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "0.2", vnTotalWeightKg: "0.2", electronicsCount: 0 },
    ]);
    const r = await settlement("2026-03");
    expect([r.rows[0].declaredKg, r.totalDeclaredKg, r.totalVnKg]).toEqual([0.3, 0.3, 0.3]);
  });

  it("settlement_cartonOtherMonth_excluded", async () => {
    mp.carton.findMany.mockResolvedValue([{ id: "c6", route: "air", packedDate: new Date("2026-04-01T00:00:00Z"), declaredWeightKg: "10", vnTotalWeightKg: null, electronicsCount: 1 }]);
    const r = await settlement("2026-03");
    expect([r.rows, r.totalDeclaredKg]).toEqual([[], 0]);
  });

  it("settlement_electronics_perRowAndTotalVndUseUnit", async () => {
    config({ [ELECTRONICS]: "1500" });
    mp.carton.findMany.mockResolvedValue([
      { id: "c7", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: null, vnTotalWeightKg: null, electronicsCount: 2 },
      { id: "c8", route: "air", packedDate: new Date("2026-03-03T00:00:00Z"), declaredWeightKg: null, vnTotalWeightKg: null, electronicsCount: 1 },
    ]);
    const r = await settlement("2026-03");
    expect(r.rows.map((x) => x.electronicsVnd)).toEqual([3000, 1500]);
    expect([r.totalElectronicsCount, r.totalElectronicsVnd]).toEqual([3, 4500]);
  });

  it("settlement_splitAndCost_perDayDiffAndTotals", async () => {
    config({ [AIR]: "100000", [SEA]: "30000" });
    mp.carton.findMany.mockResolvedValue([
      { id: "a1", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "10", vnTotalWeightKg: "9", electronicsCount: 0 },
      { id: "s1", route: "sea", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "20", vnTotalWeightKg: "20", electronicsCount: 0 },
    ]);
    mp.tracking.findMany.mockImplementation(async ({ where }: any) => (where.cartonId ? [
      { cartonId: "a1", vnWeightKg: "4", jpWeightKg: null, orderId: "o1" },
      { cartonId: "a1", vnWeightKg: "5.5", jpWeightKg: null, orderId: "o2" },
      { cartonId: "s1", vnWeightKg: "21", jpWeightKg: null, orderId: "o3" },
      { cartonId: "s1", vnWeightKg: null, jpWeightKg: "1", orderId: "o4" },
    ] : []));
    const r = await settlement("2026-03");
    expect(mp.tracking.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { cartonId: { in: ["a1", "s1"] } } }));
    expect(r.rows).toEqual([expect.objectContaining({ date: "2026-03-02", cartons: 2, declaredKg: 30, splitKg: 30.5, diffKg: 0.5, costVnd: 1600000 })]);
    expect(r).toMatchObject({ totalCartons: 2, totalSplitKg: 30.5, totalDiffKg: 0.5, totalCostVnd: 1600000, prices: { air: 100000, sea: 30000 } });
  });

  it("settlement_seaPriceMissing_dayCostAndTotalNull", async () => {
    config({ [AIR]: "100000" });
    mp.carton.findMany.mockResolvedValue([
      { id: "a1", route: "air", packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "1", vnTotalWeightKg: null, electronicsCount: 0 },
      { id: "s1", route: "sea", packedDate: new Date("2026-03-03T00:00:00Z"), declaredWeightKg: "5", vnTotalWeightKg: null, electronicsCount: 0 },
    ]);
    const r = await settlement("2026-03");
    expect(r.rows.map((x) => x.costVnd)).toEqual([100000, null]);
    expect(r.totalCostVnd).toBeNull();
  });

  it("settlement_noCartons_skipsCartonTrackingQuery", async () => {
    const r = await settlement("2026-03");
    expect(mp.tracking.findMany).toHaveBeenCalledTimes(1);
    expect(mp.tracking.findMany.mock.calls[0][0].where).toEqual({ orderId: null, packedAt: { not: null } });
    expect(r).toMatchObject({ totalCartons: 0, totalCostVnd: 0, orphan: { count: 0, kg: 0, vnd: 0, codes: [] } });
  });

  it("settlement_orphanTrackingsPackedInMonth_countKgVndAndCodes", async () => {
    config({ [AIR]: "100000", [SEA]: "30000" });
    mp.tracking.findMany.mockImplementation(async ({ where }: any) => (where.orderId === null ? [
      { code: "OR1", packedAt: new Date("2026-03-05T05:00:00Z"), vnWeightKg: "1.5", jpWeightKg: "2", carton: { route: "air" } },
      { code: "OR2", packedAt: new Date("2026-03-06T05:00:00Z"), vnWeightKg: null, jpWeightKg: "4", carton: { route: "sea" } },
      { code: "OR3", packedAt: new Date("2026-03-07T05:00:00Z"), vnWeightKg: "1", jpWeightKg: null, carton: null },
      { code: "OLD", packedAt: new Date("2026-04-02T05:00:00Z"), vnWeightKg: "9", jpWeightKg: null, carton: { route: "air" } },
    ] : []));
    const r = await settlement("2026-03");
    expect(r.orphan).toEqual({ count: 3, kg: 6.5, vnd: 150000 + 120000 + 100000, codes: ["OR1", "OR2", "OR3"] });
  });

  it("settlement_orphanOnRouteWithoutPrice_vndNullNotZero", async () => {
    config({ [AIR]: "100000" });
    mp.tracking.findMany.mockImplementation(async ({ where }: any) => (where.orderId === null ? [
      { code: "OR1", packedAt: new Date("2026-03-05T05:00:00Z"), vnWeightKg: "1.5", jpWeightKg: null, carton: { route: "air" } },
      { code: "OR2", packedAt: new Date("2026-03-06T05:00:00Z"), vnWeightKg: "4", jpWeightKg: null, carton: { route: "sea" } },
    ] : []));
    const r = await settlement("2026-03");
    expect(r.orphan).toMatchObject({ count: 2, kg: 5.5, vnd: null });
  });
});
