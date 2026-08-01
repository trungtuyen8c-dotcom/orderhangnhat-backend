import { describe, it, expect } from "vitest";
import { vnDayStart, vnDayEnd } from "./accounting.routes.js";

describe("vnDayStart / vnDayEnd", () => {
  it("vnDayStart_dateString_returnsMidnightVnTimeAsUtcInstant", () => {
    expect(vnDayStart("2026-03-05").toISOString()).toBe("2026-03-04T17:00:00.000Z");
  });

  it("vnDayEnd_dateString_returnsEndOfDayVnTimeAsUtcInstant", () => {
    expect(vnDayEnd("2026-03-05").toISOString()).toBe("2026-03-05T16:59:59.999Z");
  });
});
