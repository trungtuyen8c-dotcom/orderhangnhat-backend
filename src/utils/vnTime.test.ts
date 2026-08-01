import { describe, it, expect } from "vitest";
import { vnDayStart, vnDayEnd, vnMonthKey, vnMonthRange } from "./vnTime.js";

describe("vnDayStart / vnDayEnd", () => {
  it("vnDayStart_dateString_returnsMidnightVnTimeAsUtcInstant", () => {
    expect(vnDayStart("2026-03-05").toISOString()).toBe("2026-03-04T17:00:00.000Z");
  });

  it("vnDayEnd_dateString_returnsEndOfDayVnTimeAsUtcInstant", () => {
    expect(vnDayEnd("2026-03-05").toISOString()).toBe("2026-03-05T16:59:59.999Z");
  });
});

describe("vnMonthKey", () => {
  it("vnMonthKey_dateWellWithinVnMonth_returnsThatMonth", () => {
    expect(vnMonthKey(new Date("2026-03-15T12:00:00Z"))).toBe("2026-03");
  });

  // Regression: kho quét mã lúc 03:00 sáng giờ VN ngày 1/3 = 20:00 UTC ngày 28/2.
  it("vnMonthKey_utcInstantInEarlyMorningVnWindow_returnsCorrectVnMonthNotUtcMonth", () => {
    expect(vnMonthKey(new Date("2026-02-28T20:00:00Z"))).toBe("2026-03");
  });

  it("vnMonthKey_lastSecondOfVnMonthNearUtcBoundary_staysInThatMonth", () => {
    expect(vnMonthKey(new Date("2026-03-31T16:59:59Z"))).toBe("2026-03");
  });

  it("vnMonthKey_acceptsDateStringInput_returnsSameResultAsDateObject", () => {
    expect(vnMonthKey("2026-02-28T20:00:00Z")).toBe("2026-03");
  });
});

describe("vnMonthRange", () => {
  it("vnMonthRange_midYearMonth_returnsVnStartAndNextMonthStart", () => {
    const { start, end } = vnMonthRange("2026-03");
    expect(start.toISOString()).toBe("2026-02-28T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-31T17:00:00.000Z");
  });

  // Regression: tháng 12 phải sang đúng năm sau, không tự viết new Date(y, 12, 1) rồi quên xử lý rollover.
  it("vnMonthRange_december_rollsOverToNextYearJanuary", () => {
    const { start, end } = vnMonthRange("2026-12");
    expect(start.toISOString()).toBe("2026-11-30T17:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T17:00:00.000Z");
  });

  // Timestamp đúng ranh giới sáng sớm giờ VN phải nằm trong [start,end) của tháng đó, không rơi ra ngoài.
  it("vnMonthRange_earlyMorningVnTimestamp_fallsInsideRange", () => {
    const { start, end } = vnMonthRange("2026-03");
    const t = new Date("2026-02-28T20:00:00Z").getTime(); // 03:00 sáng 1/3 giờ VN
    expect(t >= start.getTime() && t < end.getTime()).toBe(true);
  });
});
