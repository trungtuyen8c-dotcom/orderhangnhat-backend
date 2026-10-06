import ExcelJS from "exceljs";
import JSZip from "jszip";
import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import { getGridData, getSpreadsheet, quotedRange } from "../../integrations/google/googleSheets.client.js";
import { isTrackingCode, looksYellow } from "./sheet.utils.js";

export interface InvoiceTaxRow {
  trackingCode: string | null;
  itemName: string;
  price: number | null;
  bill: string | null;
}

// Đọc sheet nháp kho ("invoice test") -> lấy các dòng đang tô vàng (cần lấy thuế), dùng cho tính năng
// Chứng từ hải quan. Sheet là 1 khối liên tục do kho tự đóng gói, KHÔNG lọc theo ngày - "vàng" là do kho tự
// tô tay ngay trước khi chốt nộp hải quan, độc lập với ngày hóa đơn user nhập lúc upload chứng từ.
export async function readInvoiceTaxRows(sid: string): Promise<InvoiceTaxRow[]> {
  if (!serviceAccountEnabled()) return [];
  const meta = await getSpreadsheet<{ sheets?: { properties: { title: string } }[] }>(sid, "sheets.properties(title)");
  const tabs = (meta.sheets ?? []).map((s) => s.properties.title);
  const fields = "sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))";
  const out: InvoiceTaxRow[] = [];
  for (const tab of tabs) {
    const data = await getGridData(sid, quotedRange(tab, "A1:Z3000"), fields);
    const rows = data.sheets?.[0]?.data?.[0]?.rowData ?? [];
    let trackingCol = -1, nameCol = -1, priceCol = -1, billCol = -1, headerRow = -1;
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i]?.values ?? [];
      const idx = cells.findIndex((c) => (c.formattedValue ?? "").trim().toUpperCase().includes("TRACKING"));
      if (idx >= 0) {
        trackingCol = idx;
        headerRow = i;
        nameCol = cells.findIndex((c) => (c.formattedValue ?? "").trim() === "Tên hàng hóa");
        priceCol = cells.findIndex((c) => (c.formattedValue ?? "").trim() === "Giá tiền");
        billCol = cells.findIndex((c) => (c.formattedValue ?? "").trim().toUpperCase() === "BILL");
        break;
      }
    }
    if (trackingCol < 0) continue;
    for (let i = headerRow + 1; i < rows.length; i++) {
      const cells = rows[i]?.values ?? [];
      const codeCell = cells[trackingCol];
      const code = (codeCell?.formattedValue ?? "").trim();
      if (!isTrackingCode(code)) continue;
      if (!looksYellow(codeCell?.userEnteredFormat?.backgroundColor)) continue;
      const itemName = nameCol >= 0 ? (cells[nameCol]?.formattedValue ?? "").trim() : "";
      const priceRaw = priceCol >= 0 ? (cells[priceCol]?.formattedValue ?? "").replace(/[^\d.-]/g, "") : "";
      // Đọc cột BILL của đúng dòng; nếu trống (có sheet chỉ điền BILL ở đầu mỗi nhóm) thì dò ngược lên dòng gần nhất có giá trị.
      let bill: string | null = null;
      if (billCol >= 0) {
        for (let j = i; j > headerRow; j--) {
          const v = (rows[j]?.values?.[billCol]?.formattedValue ?? "").trim();
          if (v) { bill = v; break; }
        }
      }
      out.push({ trackingCode: code, itemName, price: priceRaw ? Number(priceRaw) : null, bill });
    }
  }
  return out;
}

// ===== File Excel upload trực tiếp =====

function argbToRgb01(argb?: string): { red: number; green: number; blue: number } | undefined {
  if (!argb) return undefined;
  const hex = argb.length === 8 ? argb.slice(2) : argb; // bỏ kênh alpha (AARRGGBB)
  if (hex.length !== 6) return undefined;
  return { red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 };
}

// Ô nằm trong vùng merge (không phải ô gốc) khiến ExcelJS ném lỗi khi đọc `.text` (MergeValue null) -> nuốt lỗi, coi như rỗng.
function safeText(cell: ExcelJS.Cell): string {
  try { return (cell.text ?? "").trim(); } catch { return ""; }
}

// Bảng màu "indexed" mặc định của OOXML (64 màu). File Numbers xuất ra thường ghi đè bảng này bằng
// <indexedColors> riêng trong xl/styles.xml (vd index 14 = vàng thay vì tím) - ExcelJS không tự tra bảng
// ghi đè này, chỉ trả về số index thô, nên phải tự đọc styles.xml để map đúng màu thật của từng file.
const DEFAULT_INDEXED_COLORS = [
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF",
  "800000", "008000", "000080", "808000", "800080", "008080", "C0C0C0", "808080",
  "9999FF", "993366", "FFFFCC", "CCFFFF", "660066", "FF8080", "0066CC", "CCCCFF",
  "000080", "FF00FF", "FFFF00", "00FFFF", "800080", "800000", "008080", "0000FF",
  "00CCFF", "CCFFFF", "CCFFCC", "FFFF99", "99CCFF", "FF99CC", "CC99FF", "FFCC99",
  "3366FF", "33CCCC", "99CC00", "FFCC00", "FF9900", "FF6600", "666699", "969696",
  "003366", "339966", "003300", "333300", "993300", "993366", "333399", "333333",
];

async function loadIndexedPalette(buffer: Buffer): Promise<string[]> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const stylesXml = await zip.file("xl/styles.xml")?.async("string");
    const block = stylesXml?.match(/<indexedColors>([\s\S]*?)<\/indexedColors>/)?.[1];
    if (!block) return DEFAULT_INDEXED_COLORS;
    const colors = [...block.matchAll(/rgb="([0-9a-fA-F]{6,8})"/g)].map((m) => m[1].slice(-6));
    return colors.length ? colors : DEFAULT_INDEXED_COLORS;
  } catch {
    return DEFAULT_INDEXED_COLORS;
  }
}

type ExcelFill = { type?: string; fgColor?: { argb?: string; indexed?: number } } | undefined;

function fillToRgb01(fill: ExcelFill, palette: string[]): { red: number; green: number; blue: number } | undefined {
  if (fill?.type !== "pattern") return undefined;
  if (fill.fgColor?.argb) return argbToRgb01(fill.fgColor.argb);
  if (fill.fgColor?.indexed !== undefined) return argbToRgb01(palette[fill.fgColor.indexed]);
  return undefined;
}

const NAME_HEADERS = ["Tên hàng hóa", "Item Name"];
const PRICE_HEADERS = ["Giá tiền", "Unit Price(JPY)", "Unit Price (JPY)"];

// File hải quan dạng GB.xxx không có cột BILL riêng, nhưng có ô "Invoice No: GB-xxxxxx" ở đầu trang
// -> dùng tạm làm mã Bill hiển thị (thay vì để trống) khi fallback quét theo tên.
function findInvoiceNo(sheet: ExcelJS.Worksheet): string | null {
  for (let r = 1; r <= Math.min(sheet.rowCount, 15); r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (!/invoice\s*no/i.test(safeText(row.getCell(c)))) continue;
      for (let c2 = c + 1; c2 <= row.cellCount; c2++) {
        const v2 = safeText(row.getCell(c2));
        if (v2 && !/invoice\s*no/i.test(v2)) return v2;
      }
    }
  }
  return null;
}

// Sheet có cột TRACKING: lấy dòng có ô mã tracking tô vàng. Trả false nếu sheet không có cột TRACKING.
function readByTrackingColumn(sheet: ExcelJS.Worksheet, palette: string[], out: InvoiceTaxRow[]): boolean {
  let trackingCol = -1, nameCol = -1, priceCol = -1, billCol = -1, headerRow = -1;
  for (let r = 1; r <= sheet.rowCount && headerRow < 0; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      if (safeText(row.getCell(c)).toUpperCase().includes("TRACKING")) { trackingCol = c; headerRow = r; break; }
    }
  }
  if (trackingCol < 0) return false;
  const hRow = sheet.getRow(headerRow);
  for (let c = 1; c <= hRow.cellCount; c++) {
    const v = safeText(hRow.getCell(c));
    if (NAME_HEADERS.includes(v)) nameCol = c;
    if (PRICE_HEADERS.includes(v)) priceCol = c;
    if (v.toUpperCase() === "BILL") billCol = c;
  }
  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const codeCell = row.getCell(trackingCol);
    const code = safeText(codeCell);
    if (!isTrackingCode(code)) continue;
    if (!looksYellow(fillToRgb01(codeCell.fill as ExcelFill, palette))) continue;
    const itemName = nameCol > 0 ? safeText(row.getCell(nameCol)) : "";
    const priceRaw = priceCol > 0 ? safeText(row.getCell(priceCol)).replace(/[^\d.-]/g, "") : "";
    // Đọc BILL đúng dòng; nếu trống thì dò ngược lên dòng gần nhất có giá trị (sheet chỉ điền BILL ở đầu nhóm).
    let bill: string | null = null;
    if (billCol > 0) {
      for (let j = r; j > headerRow; j--) {
        const v = safeText(sheet.getRow(j).getCell(billCol));
        if (v) { bill = v; break; }
      }
    }
    out.push({ trackingCode: code, itemName, price: priceRaw ? Number(priceRaw) : null, bill });
  }
  return true;
}

// Không có cột TRACKING -> tìm cột Tên hàng + Giá, quét dòng tô vàng trên cột Tên hàng (fallback khớp tên).
function readByNameColumn(sheet: ExcelJS.Worksheet, palette: string[], out: InvoiceTaxRow[]): void {
  let nameCol = -1, priceCol = -1, nameHeaderRow = -1;
  for (let r = 1; r <= sheet.rowCount && nameHeaderRow < 0; r++) {
    const row = sheet.getRow(r);
    for (let c = 1; c <= row.cellCount; c++) {
      const v = safeText(row.getCell(c));
      if (NAME_HEADERS.includes(v)) { nameCol = c; nameHeaderRow = r; }
      if (PRICE_HEADERS.includes(v)) priceCol = c;
    }
  }
  if (nameCol < 0 || priceCol < 0) return;
  const invoiceNo = findInvoiceNo(sheet);
  for (let r = nameHeaderRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const nameCell = row.getCell(nameCol);
    const itemName = safeText(nameCell);
    if (!itemName) continue;
    if (!looksYellow(fillToRgb01(nameCell.fill as ExcelFill, palette))) continue;
    const priceRaw = safeText(row.getCell(priceCol)).replace(/[^\d.-]/g, "");
    out.push({ trackingCode: null, itemName, price: priceRaw ? Number(priceRaw) : null, bill: invoiceNo });
  }
}

// Đọc file Excel chứng từ GA do người dùng upload trực tiếp (thay vì Google Sheet cấu hình sẵn) -> cùng
// quy tắc nhận diện với readInvoiceTaxRows: dò cột "TRACKING", lấy dòng có ô mã tracking tô vàng.
// Sheet không có cột TRACKING (vd file hải quan GB.xxx chỉ có Tên hàng + Giá) -> fallback quét theo TÊN
// (trackingCode=null), matchTaxRows sẽ thử khớp tên với OrderItem - kém chắc chắn hơn khớp mã, cần xác nhận lại.
export async function readInvoiceTaxRowsFromExcel(buffer: Buffer): Promise<InvoiceTaxRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const palette = await loadIndexedPalette(buffer);
  const out: InvoiceTaxRow[] = [];
  wb.eachSheet((sheet) => {
    if (!readByTrackingColumn(sheet, palette, out)) readByNameColumn(sheet, palette, out);
  });
  return out;
}
