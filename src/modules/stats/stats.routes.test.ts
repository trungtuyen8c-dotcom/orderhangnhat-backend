import { describe, it, expect } from "vitest";
import { isOrderComplete } from "./stats.routes.js";

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
