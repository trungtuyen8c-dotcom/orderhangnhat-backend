import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { applyMapping, decodeText, detectDelimiter, mappingSchema, parseAmount, parseCsv, parseDate, readStatementFile } from "./statementImport.parse.js";

describe("parseAmount", () => {
  it.each([
    ["1,234,567", 1234567], ["1.234.567", 1234567], ["-500.000", -500000], ["(1,000)", -1000],
    ["¥12,000", 12000], ["12.000 đ", 12000], ["1 234,50", 1234.5], ["1,234.50", 1234.5], ["1.234,5", 1234.5],
    ["1,5", 1.5], ["+300", 300], ["300-", -300], ["−2,000", -2000], ["0", 0], ["10.5", 10.5],
  ])("%s -> %s", (raw, expected) => expect(parseAmount(raw)).toBe(expected));
  it.each(["", "abc", "1.23.4", "--", "12a"])("invalid %s -> null", (raw) => expect(parseAmount(raw)).toBeNull());
});

describe("parseDate", () => {
  it.each([
    ["2026-10-07", "DMY", "2026-10-07"], ["2026/10/7 12:30", "DMY", "2026-10-07"], ["07/10/2026", "DMY", "2026-10-07"],
    ["10/07/2026", "MDY", "2026-10-07"], ["7-10-26", "DMY", "2026-10-07"], ["2026年10月7日", "DMY", "2026-10-07"],
    ["20261007", "DMY", "2026-10-07"],
  ] as const)("%s (%s) -> %s", (raw, fmt, expected) => expect(parseDate(raw, fmt)).toBe(expected));
  it.each(["", "31/02/2026", "2026-13-01", "hôm nay", "2026-10-071"])("invalid %s -> null", (raw) => expect(parseDate(raw)).toBeNull());
});

describe("csv", () => {
  it("parsesQuotesEmbeddedDelimitersAndNewlines", () => {
    expect(parseCsv('a,"b,c","d ""x""\nnext"\r\n1,2,3', ",")).toEqual([["a", "b,c", 'd "x"\nnext'], ["1", "2", "3"]]);
  });
  it("detectsSemicolonAndTab", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter("a\tb\n1\t2")).toBe("\t");
  });
  it("decodesUtf8BomAndShiftJis", () => {
    expect(decodeText(Buffer.from("﻿ngày", "utf8"))).toBe("ngày");
    expect(decodeText(Buffer.from([0x93, 0xfa, 0x95, 0x74]))).toBe("日付");
  });
  it("readStatementFile_csv_trimsTrailingEmptyRows", async () => {
    const rows = await readStatementFile(Buffer.from("Ngay,So tien\n07/10/2026,100\n,\n\n"), "csv");
    expect(rows).toEqual([["Ngay", "So tien"], ["07/10/2026", "100"]]);
  });
});

describe("xlsx", () => {
  it("readsFirstSheetDatesAndNumbersAsText", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Ngày", "Số tiền", "Nội dung"]);
    ws.addRow([new Date(Date.UTC(2026, 9, 7)), -150000, "CK"]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect(await readStatementFile(buf, "xlsx")).toEqual([["Ngày", "Số tiền", "Nội dung"], ["2026-10-07", "-150000", "CK"]]);
  });
});

describe("applyMapping", () => {
  const rows = [
    { rowIndex: 0, cells: ["Sao kê ví A"] },
    { rowIndex: 1, cells: ["Ngày", "Nợ", "Có", "Mô tả", "Mã"] },
    { rowIndex: 2, cells: ["07/10/2026", "100,000", "", "Mua hàng", "FT1"] },
    { rowIndex: 3, cells: ["08/10/2026", "", "250.000", "Khách CK", ""] },
    { rowIndex: 4, cells: ["", "", "", "", ""] },
    { rowIndex: 5, cells: ["xx", "1", "", "", ""] },
    { rowIndex: 6, cells: ["09/10/2026", "", "", "", ""] },
  ];
  it("debitCredit_signsAndSkipsHeaderAndBlank", () => {
    const m = mappingSchema.parse({ headerRow: 2, dateCol: 0, amountMode: "debitCredit", debitCol: 1, creditCol: 2, descriptionCol: 3, referenceCol: 4 });
    const out = applyMapping(rows, m);
    expect(out.map((r) => r.rowIndex)).toEqual([2, 3, 5, 6]);
    expect(out[0]).toMatchObject({ date: "2026-10-07", amount: -100000, description: "Mua hàng", reference: "FT1", error: null });
    expect(out[1]).toMatchObject({ amount: 250000, reference: null });
    expect(out[2].error).toBe("DATE");
    expect(out[3].error).toBe("AMOUNT");
  });
  it("signed_usesAmountColumnAsIs", () => {
    const m = mappingSchema.parse({ headerRow: 0, dateCol: 0, amountMode: "signed", amountCol: 1 });
    expect(applyMapping([{ rowIndex: 0, cells: ["2026-10-07", "-5,000"] }], m)[0].amount).toBe(-5000);
  });
  it("schema_requiresAmountColumns", () => {
    expect(mappingSchema.safeParse({ headerRow: 1, dateCol: 0, amountMode: "signed" }).success).toBe(false);
    expect(mappingSchema.safeParse({ headerRow: 1, dateCol: 0, amountMode: "debitCredit", debitCol: 1, creditCol: 1 }).success).toBe(false);
  });
});
