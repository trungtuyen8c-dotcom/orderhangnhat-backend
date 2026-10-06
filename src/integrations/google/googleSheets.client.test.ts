import { describe, it, expect } from "vitest";
import { parseSheetId } from "./googleSheets.client.js";

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
