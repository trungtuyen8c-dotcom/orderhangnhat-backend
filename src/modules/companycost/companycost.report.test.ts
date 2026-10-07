import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    appConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    tracking: { findMany: vi.fn() },
    carton: { findMany: vi.fn() },
    companyCost: { findMany: vi.fn() },
  },
}));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../accounting/accounting.repository.js", () => ({ lockOrder: vi.fn(), writeAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));

import { electronicsUnit, monthOrCurrent, reinforceUnit, report, setElectronicsUnit, setReinforceUnit, settlement } from "./companycost.service.js";
import { prisma } from "../../infrastructure/prisma.js";

const mp = prisma as any;
const REINFORCE = "reinforce_price_vnd";
const ELECTRONICS = "electronics_price_vnd";
const config = (values: Record<string, string>) =>
  mp.appConfig.findUnique.mockImplementation(async ({ where }: any) => (where.key in values ? { key: where.key, value: values[where.key] } : null));

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
    expect(r.byKind).toEqual({ reinforce: 1000, electronics: 200, weight: 8000, other: 700 });
  });

  it("report_chakubaraiEntryWithTracking_exposesTrackingOrderAndCustomer", async () => {
    mp.companyCost.findMany.mockResolvedValue([entry({ kind: "chakubarai", refId: "t1" })]);
    mp.tracking.findMany.mockImplementation(async ({ where }: any) =>
      where.id ? [{ id: "t1", code: "JP123", order: { code: "OD1", customer: { name: "Lan" } } }] : []);
    const [e] = (await report("2026-03")).entries;
    expect(e).toMatchObject({ trackingCode: "JP123", orderCode: "OD1", customerName: "Lan", kindLabel: "着払い (hàng trả sau)" });
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

describe("settlement", () => {
  it("settlement_cartonsSameDay_groupedAndSortedByDate", async () => {
    mp.carton.findMany.mockResolvedValue([
      { packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "10", vnTotalWeightKg: "9.5", electronicsCount: 1 },
      { packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: "4", vnTotalWeightKg: null, electronicsCount: null },
      { packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "5", vnTotalWeightKg: "5", electronicsCount: 2 },
    ]);
    const r = await settlement("2026-03");
    expect(r.rows.map((x) => [x.date, x.declaredKg, x.vnKg, x.electronicsCount])).toEqual([
      ["2026-03-02", 4, 0, 0],
      ["2026-03-05", 15, 14.5, 3],
    ]);
  });

  it("settlement_floatWeights_roundedTo2Decimals", async () => {
    mp.carton.findMany.mockResolvedValue([
      { packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "0.1", vnTotalWeightKg: "0.1", electronicsCount: 0 },
      { packedDate: new Date("2026-03-05T00:00:00Z"), declaredWeightKg: "0.2", vnTotalWeightKg: "0.2", electronicsCount: 0 },
    ]);
    const r = await settlement("2026-03");
    expect([r.rows[0].declaredKg, r.totalDeclaredKg, r.totalVnKg]).toEqual([0.3, 0.3, 0.3]);
  });

  it("settlement_cartonOtherMonth_excluded", async () => {
    mp.carton.findMany.mockResolvedValue([{ packedDate: new Date("2026-04-01T00:00:00Z"), declaredWeightKg: "10", vnTotalWeightKg: null, electronicsCount: 1 }]);
    const r = await settlement("2026-03");
    expect([r.rows, r.totalDeclaredKg]).toEqual([[], 0]);
  });

  it("settlement_electronics_perRowAndTotalVndUseUnit", async () => {
    config({ [ELECTRONICS]: "1500" });
    mp.carton.findMany.mockResolvedValue([
      { packedDate: new Date("2026-03-02T00:00:00Z"), declaredWeightKg: null, vnTotalWeightKg: null, electronicsCount: 2 },
      { packedDate: new Date("2026-03-03T00:00:00Z"), declaredWeightKg: null, vnTotalWeightKg: null, electronicsCount: 1 },
    ]);
    const r = await settlement("2026-03");
    expect(r.rows.map((x) => x.electronicsVnd)).toEqual([3000, 1500]);
    expect([r.totalElectronicsCount, r.totalElectronicsVnd]).toEqual([3, 4500]);
  });
});
