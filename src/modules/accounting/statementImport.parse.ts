import ExcelJS from "exceljs";
import { z } from "zod";

// Đọc file sao kê KHÔNG biết trước định dạng (M9-2): file -> bảng ô chuỗi thô; người dùng chọn cột (mapping)
// -> mỗi dòng ra ngày / số tiền có dấu / mô tả / mã tham chiếu. Hàm thuần, không đụng DB.

export const MAX_ROWS = 5000;
export const MAX_COLS = 60;
const MAX_CELL = 500;

export const mappingSchema = z.object({
  // Dòng tiêu đề (1-based). 0 = file không có tiêu đề. Dữ liệu là các dòng SAU dòng này.
  headerRow: z.number().int().min(0).max(100),
  dateCol: z.number().int().min(0).max(MAX_COLS - 1),
  // Thứ tự ngày/tháng khi năm không đứng đầu (vd 07/10/2026). Năm 4 số đứng đầu (2026/10/07) luôn tự nhận.
  dateFormat: z.enum(["DMY", "MDY"]).default("DMY"),
  // signed: 1 cột số tiền có dấu (âm = ra ví). debitCredit: 2 cột Ghi nợ (ra ví) / Ghi có (vào ví).
  amountMode: z.enum(["signed", "debitCredit"]),
  amountCol: z.number().int().min(0).max(MAX_COLS - 1).nullable().optional(),
  debitCol: z.number().int().min(0).max(MAX_COLS - 1).nullable().optional(),
  creditCol: z.number().int().min(0).max(MAX_COLS - 1).nullable().optional(),
  descriptionCol: z.number().int().min(0).max(MAX_COLS - 1).nullable().optional(),
  referenceCol: z.number().int().min(0).max(MAX_COLS - 1).nullable().optional(),
}).refine((m) => (m.amountMode === "signed" ? m.amountCol != null : m.debitCol != null && m.creditCol != null && m.debitCol !== m.creditCol), {
  message: "Thiếu cột số tiền",
});

export type StatementMapping = z.infer<typeof mappingSchema>;

export type ParsedRow = {
  rowIndex: number; // 0-based theo dòng của file
  date: string | null; // YYYY-MM-DD
  amount: number | null; // có dấu: + vào ví, - ra ví
  description: string | null;
  reference: string | null;
  error: "DATE" | "AMOUNT" | null;
};

const clip = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_CELL);

// ---- File -> ô thô ----

// UTF-8 (bỏ BOM) trước; byte không hợp lệ UTF-8 -> thử Shift_JIS (CSV ngân hàng Nhật hay dùng).
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("shift_jis").decode(buf);
  }
}

// Dấu phân cách: ký tự (, ; tab) xuất hiện nhiều nhất ở vài dòng đầu, ngoài ngoặc kép.
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join("\n");
  let best = ",", bestN = -1;
  for (const d of [",", ";", "\t"]) {
    let n = 0, q = false;
    for (const ch of sample) { if (ch === '"') q = !q; else if (!q && ch === d) n++; }
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

// CSV theo RFC 4180 (ô trong ngoặc kép, "" là dấu nháy, xuống dòng trong ô).
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") q = true;
    else if (ch === delimiter) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const pad = (n: number) => String(n).padStart(2, "0");

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return "";
  // exceljs trả ô ngày dạng Date UTC đúng ngày lịch trên file.
  if (v instanceof Date) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === "object") {
    if ("result" in v) return cellText((v as { result?: ExcelJS.CellValue }).result ?? null);
    if ("richText" in v) return (v as ExcelJS.CellRichTextValue).richText.map((r) => r.text).join("");
    if ("text" in v) return String((v as { text: unknown }).text ?? "");
    if ("error" in v) return "";
  }
  return String(v);
}

export async function readXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  // Sheet đầu tiên có dữ liệu.
  const sheet = wb.worksheets.find((s) => s.actualRowCount > 0);
  if (!sheet) return [];
  const rows: string[][] = [];
  for (let r = 1; r <= Math.min(sheet.rowCount, MAX_ROWS + 101); r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= Math.min(row.cellCount, MAX_COLS); c++) cells.push(cellText(row.getCell(c).value));
    rows.push(cells);
  }
  return rows;
}

// Bỏ dòng trống ở cuối, cắt cột/độ dài ô. Dòng trống giữa file giữ nguyên để rowIndex khớp số dòng thật.
export function normalizeRows(rows: string[][]): string[][] {
  const out = rows.map((r) => r.slice(0, MAX_COLS).map((c) => clip(String(c ?? ""))));
  while (out.length && out[out.length - 1].every((c) => c === "")) out.pop();
  return out;
}

export async function readStatementFile(buf: Buffer, ext: string): Promise<string[][]> {
  const rows = ext === "xlsx" ? await readXlsx(buf) : parseCsv(decodeText(buf));
  return normalizeRows(rows);
}

// ---- Ô -> giá trị ----

// "1,234,567" / "1.234.567" / "-1 234,50" / "(1,000)" / "¥12,000" / "12.000 đ" -> số. Không đọc được -> null.
export function parseAmount(raw: string): number | null {
  let s = raw.trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[\s '¥￥$€₫]|VND|JPY|USD|đ|円/gi, "");
  if (s.startsWith("-") || s.startsWith("−")) { neg = !neg; s = s.slice(1); }
  else if (s.startsWith("+")) s = s.slice(1);
  if (s.endsWith("-")) { neg = !neg; s = s.slice(0, -1); }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Có cả 2 dấu: dấu đứng sau cùng là phần thập phân.
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    normalized = s.split(thou).join("").replace(dec, ".");
  } else {
    const sep = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
    if (!sep) normalized = s;
    else {
      const parts = s.split(sep);
      // 1 dấu duy nhất + đúng 3 số phía sau -> phân cách nghìn (VND/JPY không có số lẻ 3 chữ số).
      const thousands = parts.length > 2 || parts[parts.length - 1].length === 3;
      if (thousands && !parts.slice(1).every((p) => p.length === 3)) return null;
      normalized = thousands ? parts.join("") : parts.join(".");
    }
  }
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Math.round((neg ? -n : n) * 100) / 100;
}

function validYmd(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

// "2026-10-07", "2026/10/07 12:30", "07/10/2026", "7-10-26", "2026年10月7日", "20261007" -> YYYY-MM-DD.
export function parseDate(raw: string, format: "DMY" | "MDY" = "DMY"): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\b|$)/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\b|$)/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [d, mo] = format === "DMY" ? [+m[1], +m[2]] : [+m[2], +m[1]];
    return validYmd(y, mo, d);
  }
  return null;
}

const at = (cells: string[], col: number | null | undefined) => (col == null ? "" : (cells[col] ?? "").trim());

// Áp mapping cho các dòng dữ liệu (sau dòng tiêu đề, bỏ dòng trống hoàn toàn).
export function applyMapping(rows: { rowIndex: number; cells: string[] }[], mapping: StatementMapping): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const { rowIndex, cells } of rows) {
    if (rowIndex < mapping.headerRow) continue;
    if (cells.every((c) => !c || !c.trim())) continue;
    const date = parseDate(at(cells, mapping.dateCol), mapping.dateFormat);
    let amount: number | null;
    if (mapping.amountMode === "signed") amount = parseAmount(at(cells, mapping.amountCol));
    else {
      const debitRaw = at(cells, mapping.debitCol), creditRaw = at(cells, mapping.creditCol);
      const debit = debitRaw ? parseAmount(debitRaw) : 0;
      const credit = creditRaw ? parseAmount(creditRaw) : 0;
      // Cả 2 ô trống, hoặc có ô không đọc được -> lỗi số tiền.
      amount = (!debitRaw && !creditRaw) || debit == null || credit == null ? null : Math.round((Math.abs(credit) - Math.abs(debit)) * 100) / 100;
    }
    out.push({
      rowIndex, date, amount,
      description: at(cells, mapping.descriptionCol) || null,
      reference: at(cells, mapping.referenceCol) || null,
      error: date == null ? "DATE" : amount == null ? "AMOUNT" : null,
    });
  }
  return out;
}
