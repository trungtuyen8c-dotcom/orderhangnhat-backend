import { describe, it, expect, vi, beforeEach } from "vitest";
import ExcelJS from "exceljs";
import JSZip from "jszip";

vi.mock("../../integrations/google/googleSheets.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/google/googleSheets.client.js")>();
  return { ...actual, getSpreadsheet: vi.fn(), getGridData: vi.fn() };
});
vi.mock("../../integrations/google/googleAuth.js", () => ({
  serviceAccountEnabled: vi.fn(() => true),
  serviceAccountEmail: vi.fn(() => "sa@test.iam.gserviceaccount.com"),
}));

import { readInvoiceTaxRows, readInvoiceTaxRowsFromExcel } from "./invoiceTaxSheet.service.js";
import * as client from "../../integrations/google/googleSheets.client.js";
import * as auth from "../../integrations/google/googleAuth.js";

const mClient = vi.mocked(client);
const mAuth = vi.mocked(auth);

// ===== Excel builder (file xlsx thật trong bộ nhớ) =====
type Fill = { argb?: string; indexed?: number };
type CellSpec = string | number | { v: string | number; fill?: Fill };
const YELLOW: Fill = { argb: "FFFFFF00" };
const WHITE: Fill = { argb: "FFFFFFFF" };

async function buildXlsx(sheets: Record<string, CellSpec[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((row, r) => row.forEach((spec, c) => {
      if (spec === "") return;
      const cell = ws.getCell(r + 1, c + 1);
      if (typeof spec === "object") {
        cell.value = spec.v;
        if (spec.fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: spec.fill };
      } else cell.value = spec;
    }));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// Chèn bảng <indexedColors> ghi đè vào styles.xml (giống file Numbers xuất ra).
async function withIndexedPalette(buf: Buffer, overrides: Record<number, string>): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("xl/styles.xml")!.async("string");
  const colors = Array.from({ length: 64 }, (_, i) => `<rgbColor rgb="FF${overrides[i] ?? "000000"}"/>`).join("");
  zip.file("xl/styles.xml", xml.replace("</styleSheet>", `<colors><indexedColors>${colors}</indexedColors></colors></styleSheet>`));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

const y = (v: string | number): CellSpec => ({ v, fill: YELLOW });

describe("readInvoiceTaxRowsFromExcel - tracking column layout", () => {
  it("readInvoiceTaxRowsFromExcel_yellowTrackingRow_returnsCodeNamePriceBill", async () => {
    const buf = await buildXlsx({ S: [
      ["BILL", "TRACKING", "Tên hàng hóa", "Giá tiền"],
      ["B-01", y("TRK00001"), "Áo", "¥1,200"],
    ] });

    const rows = await readInvoiceTaxRowsFromExcel(buf);

    expect(rows).toEqual([{ trackingCode: "TRK00001", itemName: "Áo", price: 1200, bill: "B-01" }]);
  });

  it("readInvoiceTaxRowsFromExcel_nonYellowTrackingRow_isSkipped", async () => {
    const buf = await buildXlsx({ S: [
      ["TRACKING"],
      [{ v: "TRK00001", fill: WHITE }],
      ["TRK00002"],
    ] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });

  it.each([
    ["too short", "GK12"],
    ["contains space", "TRK 0001"],
  ])("readInvoiceTaxRowsFromExcel_yellowCodeInvalid_%s_isSkipped", async (_n, code) => {
    const buf = await buildXlsx({ S: [["TRACKING"], [y(code)]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });

  it("readInvoiceTaxRowsFromExcel_headerContainsTrackingWord_detectsColumnCaseInsensitive", async () => {
    const buf = await buildXlsx({ S: [["STT", "Mã tracking JP"], ["1", y("TRK00001")]] });

    expect((await readInvoiceTaxRowsFromExcel(buf)).map((r) => r.trackingCode)).toEqual(["TRK00001"]);
  });

  it("readInvoiceTaxRowsFromExcel_englishHeaders_readsItemNameAndUnitPrice", async () => {
    const buf = await buildXlsx({ S: [
      ["TRACKING", "Item Name", "Unit Price(JPY)"],
      [y("TRK00001"), "Shirt", 980],
    ] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([{ trackingCode: "TRK00001", itemName: "Shirt", price: 980, bill: null }]);
  });

  it("readInvoiceTaxRowsFromExcel_noNameOrPriceColumn_returnsEmptyNameAndNullPrice", async () => {
    const buf = await buildXlsx({ S: [["TRACKING"], [y("TRK00001")]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([{ trackingCode: "TRK00001", itemName: "", price: null, bill: null }]);
  });

  it("readInvoiceTaxRowsFromExcel_blankPriceCell_returnsNullPrice", async () => {
    const buf = await buildXlsx({ S: [["TRACKING", "Giá tiền"], [y("TRK00001"), ""]] });

    expect((await readInvoiceTaxRowsFromExcel(buf))[0].price).toBeNull();
  });

  it("readInvoiceTaxRowsFromExcel_billOnlyOnGroupFirstRow_inheritsNearestBillAbove", async () => {
    const buf = await buildXlsx({ S: [
      ["BILL", "TRACKING"],
      ["B-01", y("TRK00001")],
      ["", y("TRK00002")],
      ["B-02", y("TRK00003")],
    ] });

    expect((await readInvoiceTaxRowsFromExcel(buf)).map((r) => r.bill)).toEqual(["B-01", "B-01", "B-02"]);
  });

  it("readInvoiceTaxRowsFromExcel_noBillAboveRow_doesNotReadHeaderAsBill", async () => {
    const buf = await buildXlsx({ S: [["BILL", "TRACKING"], ["", y("TRK00001")]] });

    expect((await readInvoiceTaxRowsFromExcel(buf))[0].bill).toBeNull();
  });

  it("readInvoiceTaxRowsFromExcel_multipleSheets_concatenatesRowsInSheetOrder", async () => {
    const buf = await buildXlsx({
      A: [["TRACKING"], [y("TRK0000A")]],
      B: [["TRACKING"], [y("TRK0000B")]],
    });

    expect((await readInvoiceTaxRowsFromExcel(buf)).map((r) => r.trackingCode)).toEqual(["TRK0000A", "TRK0000B"]);
  });

  it("readInvoiceTaxRowsFromExcel_emptySheet_returnsEmptyArray", async () => {
    const buf = await buildXlsx({ S: [] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });
});

describe("readInvoiceTaxRowsFromExcel - fill colors / palette", () => {
  it.each([
    ["light yellow FFFF99", "FFFFFF99", 1],
    ["orange FFA500", "FFFFA500", 0],
    ["green", "FF00FF00", 0],
    ["6-digit rgb without alpha", "FFFF00", 1],
  ])("readInvoiceTaxRowsFromExcel_argbFill_%s", async (_n, argb, expectedCount) => {
    const buf = await buildXlsx({ S: [["TRACKING"], [{ v: "TRK00001", fill: { argb } }]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toHaveLength(expectedCount);
  });

  it.each([
    ["index 13 = FFFF00 yellow", 13, 1],
    ["index 14 = FF00FF magenta", 14, 0],
  ])("readInvoiceTaxRowsFromExcel_indexedFillDefaultPalette_%s", async (_n, indexed, expectedCount) => {
    const buf = await buildXlsx({ S: [["TRACKING"], [{ v: "TRK00001", fill: { indexed } }]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toHaveLength(expectedCount);
  });

  it("readInvoiceTaxRowsFromExcel_fileOverridesIndexedColors_usesFilePaletteNotDefault", async () => {
    const base = await buildXlsx({ S: [["TRACKING"], [{ v: "TRK00001", fill: { indexed: 14 } }]] });
    const buf = await withIndexedPalette(base, { 14: "FFFF00" });

    expect((await readInvoiceTaxRowsFromExcel(buf)).map((r) => r.trackingCode)).toEqual(["TRK00001"]);
  });

  it("readInvoiceTaxRowsFromExcel_fileOverridesYellowIndexAway_rowNotYellow", async () => {
    const base = await buildXlsx({ S: [["TRACKING"], [{ v: "TRK00001", fill: { indexed: 13 } }]] });
    const buf = await withIndexedPalette(base, { 13: "0000FF" });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });
});

describe("readInvoiceTaxRowsFromExcel - name column fallback", () => {
  it("readInvoiceTaxRowsFromExcel_noTrackingColumn_returnsYellowNameRowsWithInvoiceNoAsBill", async () => {
    const buf = await buildXlsx({ S: [
      ["Invoice No:", "", "GB-123456"],
      [],
      ["No", "Item Name", "Unit Price (JPY)"],
      ["1", y("Shirt"), "1,500"],
      ["2", "Pants", "2000"],
    ] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([{ trackingCode: null, itemName: "Shirt", price: 1500, bill: "GB-123456" }]);
  });

  it("readInvoiceTaxRowsFromExcel_fallbackWithoutInvoiceNo_billIsNull", async () => {
    const buf = await buildXlsx({ S: [["Tên hàng hóa", "Giá tiền"], [y("Áo"), 1000]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([{ trackingCode: null, itemName: "Áo", price: 1000, bill: null }]);
  });

  it("readInvoiceTaxRowsFromExcel_invoiceNoAfterRow15_isIgnored", async () => {
    const rows: CellSpec[][] = [["Tên hàng hóa", "Giá tiền"], [y("Áo"), 1000]];
    for (let i = 0; i < 14; i++) rows.push([]);
    rows.push(["Invoice No", "GB-999"]);
    const buf = await buildXlsx({ S: rows });

    expect((await readInvoiceTaxRowsFromExcel(buf))[0].bill).toBeNull();
  });

  it("readInvoiceTaxRowsFromExcel_fallbackMissingPriceColumn_returnsNoRows", async () => {
    const buf = await buildXlsx({ S: [["Tên hàng hóa"], [y("Áo")]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });

  it("readInvoiceTaxRowsFromExcel_fallbackYellowBlankName_isSkipped", async () => {
    const buf = await buildXlsx({ S: [["Tên hàng hóa", "Giá tiền"], [{ v: " ", fill: YELLOW }, 1000]] });

    expect(await readInvoiceTaxRowsFromExcel(buf)).toEqual([]);
  });
});

// ===== Google Sheet qua wrapper client (mock) =====
type GCell = { formattedValue?: string; userEnteredFormat?: { backgroundColor?: { red?: number; green?: number; blue?: number } } };
const gy = (v: string): GCell => ({ formattedValue: v, userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 0 } } });
const g = (v: string): GCell => ({ formattedValue: v });
const grid = (rows: GCell[][]) => ({ sheets: [{ data: [{ rowData: rows.map((values) => ({ values })) }] }] });

function stubTabs(tabs: Record<string, GCell[][]>) {
  mClient.getSpreadsheet.mockResolvedValue({ sheets: Object.keys(tabs).map((title) => ({ properties: { title } })) });
  mClient.getGridData.mockImplementation(async (_sid: string, range: string) => {
    const title = Object.keys(tabs).find((t) => range === `'${t.replace(/'/g, "''")}'!A1:Z3000`);
    return grid(title ? tabs[title] : []);
  });
}

describe("readInvoiceTaxRows (Google Sheet)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mAuth.serviceAccountEnabled.mockReturnValue(true);
  });

  it("readInvoiceTaxRows_serviceAccountDisabled_returnsEmptyWithoutCallingSheets", async () => {
    mAuth.serviceAccountEnabled.mockReturnValue(false);

    expect(await readInvoiceTaxRows("sid")).toEqual([]);
    expect(mClient.getSpreadsheet).not.toHaveBeenCalled();
  });

  it("readInvoiceTaxRows_yellowTrackingRow_returnsCodeNamePriceBill", async () => {
    stubTabs({ "invoice test": [
      [g("BILL"), g("TRACKING"), g("Tên hàng hóa"), g("Giá tiền")],
      [g("B-01"), gy("TRK00001"), g("Áo"), g("¥1,200")],
    ] });

    expect(await readInvoiceTaxRows("sid")).toEqual([{ trackingCode: "TRK00001", itemName: "Áo", price: 1200, bill: "B-01" }]);
  });

  it("readInvoiceTaxRows_nonYellowOrInvalidCode_isSkipped", async () => {
    stubTabs({ S: [[g("TRACKING")], [g("TRK00001")], [gy("GK1")], [gy("TRK00002")]] });

    expect((await readInvoiceTaxRows("sid")).map((r) => r.trackingCode)).toEqual(["TRK00002"]);
  });

  it("readInvoiceTaxRows_billBlankOnRow_inheritsNearestBillAbove", async () => {
    stubTabs({ S: [
      [g("BILL"), g("TRACKING")],
      [g("B-01"), gy("TRK00001")],
      [g(""), gy("TRK00002")],
    ] });

    expect((await readInvoiceTaxRows("sid")).map((r) => r.bill)).toEqual(["B-01", "B-01"]);
  });

  it("readInvoiceTaxRows_tabWithoutTrackingHeader_isSkipped", async () => {
    stubTabs({
      Notes: [[g("Ghi chú")], [gy("TRK00009")]],
      Data: [[g("TRACKING")], [gy("TRK00001")]],
    });

    expect((await readInvoiceTaxRows("sid")).map((r) => r.trackingCode)).toEqual(["TRK00001"]);
  });

  it("readInvoiceTaxRows_tabNameWithQuote_requestsEscapedQuotedRange", async () => {
    stubTabs({ "Kho's": [[g("TRACKING")], [gy("TRK00001")]] });

    await readInvoiceTaxRows("sid");

    expect(mClient.getGridData).toHaveBeenCalledWith("sid", "'Kho''s'!A1:Z3000", expect.any(String));
  });

  it("readInvoiceTaxRows_emptySpreadsheet_returnsEmptyArray", async () => {
    mClient.getSpreadsheet.mockResolvedValue({});

    expect(await readInvoiceTaxRows("sid")).toEqual([]);
    expect(mClient.getGridData).not.toHaveBeenCalled();
  });
});
