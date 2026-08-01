import { describe, it, expect } from "vitest";
import { dayKey, effKg, cartonWeightLocked } from "./warehouse.routes.js";

describe("dayKey", () => {
  it("dayKey_nullDate_returnsNull", () => {
    expect(dayKey(null)).toBeNull();
  });

  it("dayKey_validDate_returnsIsoDateSlice", () => {
    expect(dayKey(new Date("2026-03-05T10:00:00.000Z"))).toBe("2026-03-05");
  });
});

describe("effKg", () => {
  it("effKg_vnWeightPresent_returnsVnWeight", () => {
    expect(effKg({ vnWeightKg: "5.5", jpWeightKg: "6" })).toBe(5.5);
  });

  it("effKg_vnWeightNullJpWeightPresent_returnsJpWeight", () => {
    expect(effKg({ vnWeightKg: null, jpWeightKg: "6" })).toBe(6);
  });

  it("effKg_bothNull_returnsZero", () => {
    expect(effKg({ vnWeightKg: null, jpWeightKg: null })).toBe(0);
  });
});

describe("cartonWeightLocked", () => {
  it("cartonWeightLocked_missingDeclaredWeight_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: null, vnTotalWeightKg: "5", weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_missingVnTotalWeight_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: null, weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_weightsMatchExactly_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "5", weightConfirmedAt: null })).toBe(false);
  });

  it("cartonWeightLocked_weightsDiffBelowThreshold_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "5.9", weightConfirmedAt: null })).toBe(false);
  });

  it("cartonWeightLocked_weightsDiffAtThresholdUnconfirmed_returnsTrue", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "6", weightConfirmedAt: null })).toBe(true);
  });

  it("cartonWeightLocked_weightsDiffAboveThresholdButConfirmed_returnsFalse", () => {
    expect(cartonWeightLocked({ declaredWeightKg: "5", vnTotalWeightKg: "7", weightConfirmedAt: new Date() })).toBe(false);
  });
});
