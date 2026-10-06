import { getAccessToken } from "./googleAuth.js";
import type { CellValue, GridData, GridRange, RgbColor, SheetProps, SheetsRequest, ValueRange, ValueRangeUpdate } from "./google.types.js";

// Client Google Sheets API v4 thuần: chỉ biết spreadsheet/tab/range/request, không biết nghiệp vụ.

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sheetsApi<T = any>(sid: string, path: string, method: string, body?: unknown): Promise<T> {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getAccessToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json() as Promise<T>;
    // 429 (rate limit) / 5xx là lỗi tạm thời của Google -> thử lại thay vì bỏ dở sync giữa chừng để lại dữ liệu cũ
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) throw new Error(`GSHEET_API ${method} ${path} -> ${res.status} ${await res.text()}`);
    await sleep(500 * 2 ** (attempt - 1));
  }
  throw new Error(`GSHEET_API ${method} ${path} -> retries exhausted`);
}

// ===== Helpers A1 =====

// Lấy spreadsheet ID từ link hoặc chính ID
export function parseSheetId(input?: string | null): string | null {
  if (!input) return null;
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(input.trim()) ? input.trim() : null;
}

export const colLetter = (i: number): string => (i < 26 ? "" : colLetter(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

// Range A1 có tên tab đặt trong nháy đơn (escape ' -> '') - dùng trong body batchGet/batchUpdate.
export const quotedRange = (tab: string, a1: string) => `'${tab.replace(/'/g, "''")}'!${a1}`;

// ===== Metadata =====

export async function getSpreadsheet<T = unknown>(sid: string, fields: string): Promise<T> {
  return sheetsApi<T>(sid, `?fields=${encodeURIComponent(fields)}`, "GET");
}

export async function listSheetTitles(sid: string): Promise<string[]> {
  const meta = await sheetsApi<{ sheets?: { properties: { title: string } }[] }>(sid, `?fields=sheets.properties.title`, "GET");
  return (meta.sheets ?? []).map((s) => s.properties.title);
}

export async function listSheets(sid: string): Promise<SheetProps[]> {
  const meta = await sheetsApi<{ sheets?: { properties: SheetProps }[] }>(sid, `?fields=sheets.properties(title,sheetId)`, "GET");
  return (meta.sheets ?? []).map((s) => s.properties);
}

export async function getSheetIdByTitle(sid: string, title: string): Promise<number | null> {
  for (const s of await listSheets(sid)) if (s.title === title) return s.sheetId;
  return null;
}

// Tạo tab nếu chưa có.
export async function ensureSheetTab(sid: string, title: string): Promise<void> {
  const titles = await listSheetTitles(sid);
  if (!titles.includes(title)) {
    await sheetsApi(sid, `:batchUpdate`, "POST", { requests: [{ addSheet: { properties: { title } } }] });
  }
}

// ===== Values =====

// `a1` là phần sau dấu "!" (vd "A1:A20", "3:3"); tên tab được encode riêng.
export async function getValues(sid: string, tab: string, a1: string): Promise<string[][]> {
  const data = await sheetsApi<ValueRange>(sid, `/values/${encodeURIComponent(tab)}!${a1}`, "GET");
  return data.values ?? [];
}

export function updateValues(sid: string, tab: string, a1: string, body: { values: CellValue[][]; majorDimension?: "ROWS" | "COLUMNS" }) {
  return sheetsApi(sid, `/values/${encodeURIComponent(tab)}!${a1}?valueInputOption=USER_ENTERED`, "PUT", body);
}

export function appendValues(sid: string, tab: string, a1: string, values: CellValue[][]) {
  return sheetsApi(sid, `/values/${encodeURIComponent(tab)}!${a1}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, "POST", { values });
}

export function clearValues(sid: string, tab: string, a1: string) {
  return sheetsApi(sid, `/values/${encodeURIComponent(tab)}!${a1}:clear`, "POST", {});
}

// `ranges` là range đầy đủ (vd quotedRange(tab, "A1:X100000")).
export async function batchGetValues(sid: string, ranges: string[], majorDimension?: "ROWS" | "COLUMNS"): Promise<ValueRange[]> {
  const q = ranges.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const data = await sheetsApi<{ valueRanges?: ValueRange[] }>(sid, `/values:batchGet?${q}${majorDimension ? `&majorDimension=${majorDimension}` : ""}`, "GET");
  return data.valueRanges ?? [];
}

// Không truyền chunkSize -> 1 request duy nhất; có chunkSize -> chia nhỏ (tránh payload quá lớn), 0 phần tử thì không gọi.
export async function batchUpdateValues(sid: string, data: ValueRangeUpdate[], chunkSize?: number): Promise<void> {
  if (!chunkSize) {
    await sheetsApi(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data });
    return;
  }
  for (let i = 0; i < data.length; i += chunkSize) {
    await sheetsApi(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data: data.slice(i, i + chunkSize) });
  }
}

// ===== Formatting / structure (spreadsheets.batchUpdate) =====

export async function batchUpdate(sid: string, requests: SheetsRequest[], chunkSize?: number): Promise<void> {
  if (!chunkSize) {
    await sheetsApi(sid, `:batchUpdate`, "POST", { requests });
    return;
  }
  for (let i = 0; i < requests.length; i += chunkSize) {
    await sheetsApi(sid, `:batchUpdate`, "POST", { requests: requests.slice(i, i + chunkSize) });
  }
}

// Đọc giá trị + định dạng ô (vd màu nền) của 1 range.
export function getGridData(sid: string, range: string, fields: string): Promise<GridData> {
  return sheetsApi<GridData>(sid, `?ranges=${encodeURIComponent(range)}&fields=${encodeURIComponent(fields)}`, "GET");
}

// Range 1 dòng (row 1-based), cột 0-based [startCol, endCol).
export const rowRange = (sheetId: number, row: number, startCol: number, endCol: number): GridRange => ({
  sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: startCol, endColumnIndex: endCol,
});

export const backgroundRequest = (range: GridRange, color: RgbColor): SheetsRequest => ({
  repeatCell: { range, cell: { userEnteredFormat: { backgroundColor: color } }, fields: "userEnteredFormat.backgroundColor" },
});

export const checkboxValidationRequest = (range: GridRange): SheetsRequest => ({
  setDataValidation: { range, rule: { condition: { type: "BOOLEAN" }, strict: true } },
});

export const clearValidationRequest = (range: GridRange): SheetsRequest => ({ setDataValidation: { range } });

export const numberFormatRequest = (range: GridRange, pattern: string): SheetsRequest => ({
  repeatCell: { range, cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern } } }, fields: "userEnteredFormat.numberFormat" },
});

export const protectedRangeRequest = (range: GridRange, description: string, editorEmails: string[]): SheetsRequest => ({
  addProtectedRange: { protectedRange: { range, description, warningOnly: false, editors: { users: editorEmails } } },
});
