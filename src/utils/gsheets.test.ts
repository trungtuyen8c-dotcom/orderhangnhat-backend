import { describe, it, expect } from "vitest";
import { parseSheetId, tabDate } from "./gsheets.js";

describe("parseSheetId", () => {
  it("parseSheetId_nullInput_returnsNull", () => {
    expect(parseSheetId(null)).toBeNull();
  });

  it("parseSheetId_emptyString_returnsNull", () => {
    expect(parseSheetId("")).toBeNull();
  });

  it("parseSheetId_fullSheetsUrl_extractsId", () => {
    expect(parseSheetId("https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0")).toBe(
      "1AbCdEfGhIjKlMnOpQrStUvWxYz"
    );
  });

  it("parseSheetId_bareIdAtLeast20Chars_returnsTrimmedId", () => {
    expect(parseSheetId("  1AbCdEfGhIjKlMnOpQrS  ")).toBe("1AbCdEfGhIjKlMnOpQrS");
  });

  it("parseSheetId_shortInvalidString_returnsNull", () => {
    expect(parseSheetId("abc123")).toBeNull();
  });
});

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
