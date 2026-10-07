import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    order: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn() },
    customer: { count: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { isOrderComplete, getAlerts, getOverview, getMonthly } from "./stats.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";

const mp = prisma as any;

const packedTracking = { packedAt: new Date(), needsTax: false, taxCollected: false, jpWeightKg: "1", vnWeightKg: "1" };
const baseOrder = {
  externalWarehouse: false,
  skipVnWeighing: false,
  items: [{ unitPriceJpy: "1000" }],
  trackings: [packedTracking],
};

describe("isOrderComplete", () => {
  it("isOrderComplete_noTrackings_returnsFalse", () => {
    expect(isOrderComplete({ ...baseOrder, trackings: [] })).toBe(false);
  });

  it("isOrderComplete_anyItemZeroPrice_returnsFalse", () => {
    expect(isOrderComplete({ ...baseOrder, items: [{ unitPriceJpy: "0" }] })).toBe(false);
  });

  it("isOrderComplete_anyTrackingNotPacked_returnsFalse", () => {
    expect(isOrderComplete({ ...baseOrder, trackings: [{ ...packedTracking, packedAt: null }] })).toBe(false);
  });

  it("isOrderComplete_trackingNeedsTaxNotCollected_returnsFalse", () => {
    expect(isOrderComplete({ ...baseOrder, trackings: [{ ...packedTracking, needsTax: true, taxCollected: false }] })).toBe(false);
  });

  it("isOrderComplete_missingWeightsAndNotExternalNotSkip_returnsFalse", () => {
    expect(isOrderComplete({ ...baseOrder, trackings: [{ ...packedTracking, jpWeightKg: null }] })).toBe(false);
  });

  it("isOrderComplete_missingWeightsButExternalWarehouse_returnsTrueIgnoringWeights", () => {
    expect(isOrderComplete({ ...baseOrder, externalWarehouse: true, trackings: [{ ...packedTracking, jpWeightKg: null, vnWeightKg: null }] })).toBe(true);
  });

  it("isOrderComplete_missingWeightsButSkipVnWeighing_returnsTrueIgnoringWeights", () => {
    expect(isOrderComplete({ ...baseOrder, skipVnWeighing: true, trackings: [{ ...packedTracking, jpWeightKg: null, vnWeightKg: null }] })).toBe(true);
  });

  it("isOrderComplete_allConditionsSatisfied_returnsTrue", () => {
    expect(isOrderComplete(baseOrder)).toBe(true);
  });
});

import { lastMonthKeys, parseMonthsParam } from "./stats.service.js";

describe("lastMonthKeys", () => {
  it("lastMonthKeys_acrossYearBoundary_returnsContiguousAscending", () => {
    expect(lastMonthKeys(3, new Date("2026-02-10T00:00:00Z"))).toEqual(["2025-12", "2026-01", "2026-02"]);
  });

  it("lastMonthKeys_utcLateNightIsNextVnMonth_endsAtVnMonth", () => {
    // 2026-03-31 18:00 UTC = 2026-04-01 01:00 giờ VN
    expect(lastMonthKeys(1, new Date("2026-03-31T18:00:00Z"))).toEqual(["2026-04"]);
  });
});

describe("parseMonthsParam", () => {
  it("parseMonthsParam_missingOrInvalid_defaults12", () => {
    expect(parseMonthsParam(undefined)).toBe(12);
    expect(parseMonthsParam("abc")).toBe(12);
  });

  it("parseMonthsParam_outOfRange_clampsTo1And24", () => {
    expect(parseMonthsParam("0")).toBe(1);
    expect(parseMonthsParam("99")).toBe(24);
    expect(parseMonthsParam("6")).toBe(6);
  });
});

describe("getAlerts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getAlerts_nothingCached_returnsEmptyAlerts", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    expect(await getAlerts()).toEqual({ count: 0, orders: [] });
  });

  it("getAlerts_cachedJson_returnsParsedValue", async () => {
    (redis.get as ReturnType<typeof vi.fn>).mockResolvedValue('{"count":2,"orders":["A","B"]}');
    expect(await getAlerts()).toEqual({ count: 2, orders: ["A", "B"] });
  });
});

describe("getOverview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getOverview_liveOrders_splitsCompletedAndInProgressAndMapsStatusCounts", async () => {
    mp.order.groupBy.mockResolvedValue([{ status: "draft", _count: { _all: 2 } }]);
    mp.customer.count.mockResolvedValue(5);
    mp.order.count.mockImplementation(async (a: any) => (a?.where?.status === "cancelled" ? 1 : 4));
    mp.order.findMany.mockResolvedValue([baseOrder, { ...baseOrder, trackings: [] }, baseOrder]);
    expect(await getOverview()).toEqual({
      totalOrders: 4, customers: 5, completedOrders: 2, inProgressOrders: 1, cancelledOrders: 1,
      byStatus: [{ status: "draft", count: 2 }],
    });
  });
});

describe("getMonthly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("getMonthly_withoutMoney_fillsMissingMonthsWithZerosAndOmitsMoneyFields", async () => {
    mp.$queryRaw.mockResolvedValueOnce([{ month: "2026-02", waiting: 1, shipping: 2, done: 3, cancelled: 4, revenue: "999" }]);
    const r = await getMonthly(2, false);
    expect(r).toEqual([
      { month: "2026-02", waiting: 1, shipping: 2, done: 3, cancelled: 4 },
      { month: "2026-03", waiting: 0, shipping: 0, done: 0, cancelled: 0 },
    ]);
    expect(mp.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("getMonthly_withMoney_addsRevenueAndSpendDefaultingToZero", async () => {
    mp.$queryRaw
      .mockResolvedValueOnce([{ month: "2026-03", waiting: 0, shipping: 0, done: 1, cancelled: 0, revenue: "1500000" }])
      .mockResolvedValueOnce([{ month: "2026-02", total: "42000" }]);
    const r = await getMonthly(2, true);
    expect(r.map((m) => [m.month, m.revenueVnd, m.spendJpy])).toEqual([["2026-02", 0, 42000], ["2026-03", 1500000, 0]]);
  });
});
