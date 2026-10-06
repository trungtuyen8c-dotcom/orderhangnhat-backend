import { describe, it, expect } from "vitest";
import { isOrderComplete } from "./stats.service.js";

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
