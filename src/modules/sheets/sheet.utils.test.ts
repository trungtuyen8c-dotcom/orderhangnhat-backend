import { describe, it, expect } from "vitest";
import { seaTabDate, tabDate } from "./sheet.utils.js";

describe("tabDate", () => {
  it("tabDate_nonDateTitle_returnsNull", () => {
    expect(tabDate("TRANG MẪU")).toBeNull();
  });

  it("tabDate_dayOutOfRange_returnsNull", () => {
    expect(tabDate("32.1")).toBeNull();
  });

  it("tabDate_monthOutOfRange_returnsNull", () => {
    expect(tabDate("1.13")).toBeNull();
  });

  it("tabDate_pastDayInCurrentYear_usesCurrentYear", () => {
    const now = new Date(2026, 5, 15); // 15/6/2026
    expect(tabDate("8.6", now)?.getTime()).toBe(new Date(2026, 5, 8).getTime());
  });

  it("tabDate_nearFutureWithinCurrentYear_notShiftedBack", () => {
    const now = new Date(2026, 5, 1); // 1/6/2026
    expect(tabDate("15.6", now)?.getTime()).toBe(new Date(2026, 5, 15).getTime());
  });

  // Regression: quét tab "31.12" (không ghi năm) vào đầu tháng 1 năm sau từng bị ghép nhầm thành
  // 31/12 NĂM SAU (lệch gần 1 năm) vì luôn lấy new Date().getFullYear().
  it("tabDate_decemberTabScannedEarlyNextJanuary_usesPreviousYearNotCurrent", () => {
    const now = new Date(2027, 0, 5); // 5/1/2027
    expect(tabDate("31.12", now)?.getTime()).toBe(new Date(2026, 11, 31).getTime());
  });
});

describe("seaTabDate", () => {
  const now = new Date(2026, 9, 9); // 9/10/2026

  it.each([
    ["Biển Tháng10", 9],
    ["bien t9", 8],
    ["biển T6", 5],
    ["bien tháng 4 chuyến 2(Tháng5)", 3],
    ["Bien thang 03", 2],
  ])("seaTabDate_%s_returnsFirstDayOfThatMonth", (title, monthIdx) => {
    expect(seaTabDate(title, now)?.getTime()).toBe(new Date(2026, monthIdx, 1).getTime());
  });

  it.each(["9.10", "TRANG MẪU", "Biển", "bien t13", "bien t0", "Malaysia t9", "biểnT9"])(
    "seaTabDate_%s_returnsNull",
    (title) => {
      expect(seaTabDate(title, now)).toBeNull();
    },
  );

  it("seaTabDate_decemberTabScannedInJanuary_usesPreviousYear", () => {
    expect(seaTabDate("Biển Tháng12", new Date(2027, 0, 5))?.getTime()).toBe(new Date(2026, 11, 1).getTime());
  });
});
