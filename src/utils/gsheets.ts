import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prisma } from "../db.js";
import { recomputeOrderTotals, trackingShipVnd } from "./orderTotals.js";
import { deleteCartonIfEmpty } from "./cartons.js";

// Đồng bộ Tracking sang Google Sheets bằng service account.
// Bật khi có đủ env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GSHEET_ID (GSHEET_TAB mặc định "Tracking").
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const SHEET_ID = process.env.GSHEET_ID;
const TAB = process.env.GSHEET_TAB ?? "Tracking";

export const gsheetsEnabled = () => Boolean(SA_EMAIL && SA_KEY && SHEET_ID);
const saEnabled = () => Boolean(SA_EMAIL && SA_KEY);

// Lấy spreadsheet ID từ link hoặc chính ID
export function parseSheetId(input?: string | null): string | null {
  if (!input) return null;
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(input.trim()) ? input.trim() : null;
}

const HEADER = ["ID", "Mã tracking", "Tên (JP)", "Cân (kg)", "Đơn giá đ/kg", "Thành tiền VND", "Tracking VN", "Đơn (orderId)", "Trạng thái", "Cập nhật"];

let cachedToken: { token: string; exp: number } | null = null;

async function getToken(): Promise<string> {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const iat = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    { scope: "https://www.googleapis.com/auth/spreadsheets", aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 },
    SA_KEY,
    { algorithm: "RS256", issuer: SA_EMAIL },
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error("GSHEET_AUTH_FAILED " + res.status);
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiSheet(sid: string, path: string, method: string, body?: unknown) {
  const maxAttempts = 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getToken();
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    // 429 (rate limit) / 5xx là lỗi tạm thời của Google -> thử lại thay vì bỏ dở sync giữa chừng để lại dữ liệu cũ
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === maxAttempts) throw new Error(`GSHEET_API ${method} ${path} -> ${res.status} ${await res.text()}`);
    await sleep(500 * 2 ** (attempt - 1));
  }
  throw new Error(`GSHEET_API ${method} ${path} -> retries exhausted`);
}
const api = (path: string, method: string, body?: unknown) => apiSheet(SHEET_ID!, path, method, body);

interface TrackingRow {
  id: string; code: string; jpName?: unknown; jpWeightKg?: unknown;
  unitPriceVndPerKg?: unknown; vnTrackingCode?: unknown; orderId?: unknown; status?: unknown;
}

function rowValues(t: TrackingRow): (string | number)[] {
  const kg = Number(t.jpWeightKg ?? 0);
  const unit = Number(t.unitPriceVndPerKg ?? 0);
  return [
    t.id, t.code, String(t.jpName ?? ""), kg || "", unit || "", kg * unit || "",
    String(t.vnTrackingCode ?? ""), String(t.orderId ?? ""), String(t.status ?? ""), new Date().toISOString(),
  ];
}

// Tìm số dòng theo ID ở cột A (1-based). 0 nếu chưa có.
async function findRow(id: string): Promise<number> {
  const data = (await api(`/values/${encodeURIComponent(TAB)}!A:A`, "GET")) as { values?: string[][] };
  const rows = data.values ?? [];
  for (let i = 0; i < rows.length; i++) if (rows[i]?.[0] === id) return i + 1;
  return 0;
}

let tabReady = false;
async function ensureTab(): Promise<void> {
  if (tabReady) return;
  const meta = (await api(`?fields=sheets.properties.title`, "GET")) as { sheets?: { properties: { title: string } }[] };
  if (!meta.sheets?.some((s) => s.properties.title === TAB)) {
    await api(`:batchUpdate`, "POST", { requests: [{ addSheet: { properties: { title: TAB } } }] });
  }
  tabReady = true;
}

async function ensureHeader(): Promise<void> {
  await ensureTab();
  const data = (await api(`/values/${encodeURIComponent(TAB)}!A1:A1`, "GET")) as { values?: string[][] };
  if (!data.values?.length) {
    await api(`/values/${encodeURIComponent(TAB)}!A1?valueInputOption=USER_ENTERED`, "PUT", { values: [HEADER] });
  }
}

// Upsert 1 tracking. Không làm chết request nếu lỗi.
export async function syncTracking(t: TrackingRow): Promise<void> {
  if (!gsheetsEnabled()) return;
  try {
    await ensureHeader();
    const row = await findRow(t.id);
    if (row) {
      await api(`/values/${encodeURIComponent(TAB)}!A${row}?valueInputOption=USER_ENTERED`, "PUT", { values: [rowValues(t)] });
    } else {
      await api(`/values/${encodeURIComponent(TAB)}!A1:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, "POST", { values: [rowValues(t)] });
    }
  } catch (e) {
    console.error("[gsheets] syncTracking", (e as Error).message);
  }
}

// Xóa dòng (ghi trắng) khi tracking bị xóa.
export async function removeTrackingRow(id: string): Promise<void> {
  if (!gsheetsEnabled()) return;
  try {
    const row = await findRow(id);
    if (row) await api(`/values/${encodeURIComponent(TAB)}!A${row}:J${row}:clear`, "POST", {});
  } catch (e) {
    console.error("[gsheets] removeTrackingRow", (e as Error).message);
  }
}

// ===== Xuất đơn theo từng khách: mỗi khách 1 tab, layout giống file khách =====
// Template MẶC ĐỊNH khi tạo tab mới (A→N). Nhiều khách tự chèn thêm cột riêng (vd "Đơn giá vận chuyển") vào
// giữa các cột này -> KHÔNG ghi theo vị trí cố định nữa, mà dò đúng cột theo TÊN tiêu đề thực tế của từng khách
// (xem readHeaderColumns/FIELD_HEADER bên dưới), để không bao giờ ghi lệch cột dù khách chèn/xóa cột tùy ý.
const ORDER_HEADER = [
  "Mã Link", "Ngày đặt", "ACC", "LINK đặt", "Phương thức thanh toán", "GIÁ WEB", "SHIP WEB",
  "% Công", "Tổng tiền bao gồm tiền công", "Cân-Kg", "Phụ thu", "TRACKING", "Đánh giá", "Ngày giao cho khách hàng",
];

// Các trường hệ thống TỰ QUẢN LÝ - chỉ ghi vào đúng cột có tiêu đề khớp tên bên dưới, tuyệt đối không đụng
// cột khác (vd "% Công") vì đó là kế toán tự nhập tay, không phải hệ thống ghi.
// 3 dòng cuối (shipRate/shipTotal/grandTotal) là cột MỚI 1 số khách tự thêm - chỉ ghi nếu khách CÓ cột đó.
const FIELD_HEADER = {
  code: "Mã Link", date: "Ngày đặt", acc: "ACC", url: "LINK đặt", method: "Phương thức thanh toán",
  giaWeb: "GIÁ WEB", ship: "SHIP WEB", total: "Tổng tiền bao gồm tiền công",
  rate: "tỉ giá", vndConverted: "Tổng tiền KH quy đổi VND",
  weight: "Cân-Kg", surcharge: "Phụ thu", tracking: "TRACKING", review: "Đánh giá",
  deliveredAt: "Ngày giao cho khách hàng",
  shipRate: "Đơn giá vận chuyển", shipTotal: "Tổng tiền vận chuyển", grandTotal: "Tổng tiền VND+ Vận chuyển",
  stored: "lưu kho", vnTrack: "tracking việt nam",
} as const;
type FieldKey = keyof typeof FIELD_HEADER;

// Format theo giờ VN (UTC+7) bất kể timezone của server -> tránh lệch -1 ngày.
const VN_OFFSET_MS = 7 * 3600 * 1000;
function vnDate(d: Date | string | number): Date {
  return new Date(new Date(d).getTime() + VN_OFFSET_MS);
}
function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = vnDate(d);
  return `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
}

async function ensureNamedTab(sid: string, title: string): Promise<void> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties.title`, "GET")) as { sheets?: { properties: { title: string } }[] };
  if (!meta.sheets?.some((s) => s.properties.title === title)) {
    await apiSheet(sid, `:batchUpdate`, "POST", { requests: [{ addSheet: { properties: { title: title } } }] });
  }
}

type OrderFull = Awaited<ReturnType<typeof loadCustomerOrders>>[number];
function loadCustomerOrders(customerId: string) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "asc" },
    include: { items: true, trackings: true, payments: true },
  });
}

type FieldRow = Partial<Record<FieldKey, string | number>>;

// Dòng data theo TỪNG MÓN, gom theo THÁNG NGÀY MUA của chính món đó (không theo ngày tạo đơn).
// Trả field-key -> giá trị (không phải mảng theo vị trí cột) - runCustomerSync tự dò đúng cột theo tiêu đề thực
// của từng khách để ghi, tránh lệch cột khi khách chèn thêm cột riêng.
// Trả map: tháng -> { rows, jpyTotal: tổng ¥ (mirror "Tổng tiền"), vndTotal: tổng quy đổi ₫ các món có tỉ giá }.
function buildRowsByMonth(orders: OrderFull[], codByTracking?: Map<string, number>, custShipRateVnd?: number | null): Map<number, { rows: FieldRow[]; jpyTotal: number; vndTotal: number }> {
  const byMonth = new Map<number, { date: Date; row: FieldRow; jpy: number; vnd: number }[]>();
  const bucket = (m: number) => { let b = byMonth.get(m); if (!b) { b = []; byMonth.set(m, b); } return b; };
  for (const o of orders) {
    const rate = Number(o.exchangeRate ?? 0);
    const surchargeVnd = o.surchargeCurrency === "JPY" ? Number(o.surchargeAmount) * rate : Number(o.surchargeAmount);
    o.items.forEach((it, idx) => {
      const giaWeb = it.qty * Number(it.unitPriceJpy);
      const ship = Number(it.shipJpy ?? 0);
      const trk = o.trackings[idx];
      const purchaseDate = it.purchaseDate ?? o.createdAt;
      const m = vnDate(purchaseDate).getUTCMonth() + 1;
      // Phụ thu = phụ thu tay của cả đơn (chỉ món đầu) + 着払い/COD kho báo riêng cho đúng mã tracking của món này
      const codVnd = trk ? (codByTracking?.get(trk.id) ?? 0) : 0;
      const surchargeCell = (idx === 0 ? surchargeVnd : 0) + codVnd;
      // Ship của cả đơn (order.shipAmount - phí ship/thanh toán tay, vd COMBINI) chỉ cộng vào món đầu (tránh nhân đôi
      // khi đơn nhiều món). Cùng đơn vị ¥ với ship món -> ghép thành công thức "=shipMón+shipĐơn" để khách bấm vào
      // sheet thấy rõ 2 khoản cộng ra sao; khác đơn vị (VND) thì cộng thẳng vào ₫ quy đổi, không ghép công thức được.
      const orderShipJpy = idx === 0 && o.shipCurrency === "JPY" ? Number(o.shipAmount ?? 0) : 0;
      const orderShipVndOnly = idx === 0 && o.shipCurrency !== "JPY" ? Number(o.shipAmount ?? 0) : 0;
      const shipCell: string | number = orderShipJpy > 0 ? (ship > 0 ? `=${ship}+${orderShipJpy}` : orderShipJpy) : (ship || "");
      // Ưu tiên cân VN (đã cân lại thực tế) nếu có - khớp đúng cân dùng để tính phí ship thật (trackingShipVnd),
      // không phải cân JP khai báo ban đầu, tránh sheet khách hiện cân khác với cân đã tính tiền.
      const weight = trk?.vnWeightKg != null ? Number(trk.vnWeightKg) : (trk?.jpWeightKg != null ? Number(trk.jpWeightKg) : null);
      // Quy đổi đúng ra ₫/kg để hiện khớp với "Tổng tiền vận chuyển" (= cân x đơn giá này) - đơn giá tracking có
      // thể để theo ¥ (shipRateCurrency) nên phải nhân tỉ giá, đơn giá mặc định của khách luôn tính sẵn theo ₫.
      const rawShipRate = trk?.unitPriceVndPerKg != null ? Number(trk.unitPriceVndPerKg) : custShipRateVnd ?? null;
      const shipVndPerKg = rawShipRate != null ? (trk?.shipRateCurrency === "JPY" ? rawShipRate * rate : rawShipRate) : null;
      const shipTotal = trk ? trackingShipVnd({ ...trk, unitPriceVndPerKg: trk.unitPriceVndPerKg ?? custShipRateVnd ?? null }, rate) : 0;
      const jpy = giaWeb + ship + orderShipJpy;
      const vnd = (rate ? Math.round(jpy * rate) : 0) + orderShipVndOnly;
      const grandTotal = vnd + Math.round(shipTotal);
      const row: FieldRow = {
        code: o.items.length > 1 ? `${o.code}.${idx + 1}` : o.code,
        date: fmtDate(purchaseDate),
        acc: String(o.nick ?? ""),
        url: String(it.url ?? ""), method: String(it.paymentMethod ?? ""),
        giaWeb: giaWeb || "", ship: shipCell, total: jpy,
        rate: rate || "", vndConverted: vnd || "",
        weight: weight ?? "",
        surcharge: surchargeCell ? Math.round(surchargeCell) : "",
        shipRate: shipVndPerKg ? Math.round(shipVndPerKg) : "",
        shipTotal: shipTotal ? Math.round(shipTotal) : "",
        tracking: String(trk?.code ?? ""), review: String(trk?.review ?? ""),
        deliveredAt: trk?.deliveredAt ? fmtDate(trk.deliveredAt) : "",
        grandTotal: grandTotal ? grandTotal : "",
        // Chỉ tính "đang lưu kho" khi CHƯA ship (chưa có Tracking VN) - có Tracking VN rồi thì coi như đã ship,
        // tự bỏ chữ/màu "lưu kho" dù status DB vẫn còn "stored" (không reset lại khi nhập Tracking VN).
        stored: (trk?.status === "stored" && !trk?.vnTrackingCode) ? "lưu kho" : "",
        vnTrack: String(trk?.vnTrackingCode ?? ""),
      };
      bucket(m).push({ date: purchaseDate, row, jpy, vnd });
    });
  }
  const result = new Map<number, { rows: FieldRow[]; jpyTotal: number; vndTotal: number }>();
  for (const [m, entries] of byMonth) {
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    result.set(m, {
      rows: entries.map((e) => e.row),
      jpyTotal: entries.reduce((s, e) => s + e.jpy, 0),
      vndTotal: entries.reduce((s, e) => s + e.vnd, 0),
    });
  }
  return result;
}

// Liệt kê mọi tab dạng tháng -> map {số tháng: tên tab}
async function listMonthTabs(sid: string): Promise<Map<number, string>> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties.title`, "GET")) as { sheets?: { properties: { title: string } }[] };
  const map = new Map<number, string>();
  for (const s of meta.sheets ?? []) {
    const mm = s.properties.title.trim().toLowerCase().match(/^(?:tháng|thang|t)?\s*0*(\d{1,2})$/);
    if (mm) map.set(Number(mm[1]), s.properties.title);
  }
  return map;
}

// Dò dòng tiêu đề (ô A == "Mã Link") trong tab; trả 0 nếu không thấy.
async function findHeaderRow(sid: string, tab: string): Promise<number> {
  const data = (await apiSheet(sid, `/values/${encodeURIComponent(tab)}!A1:A20`, "GET")) as { values?: string[][] };
  const rows = data.values ?? [];
  for (let i = 0; i < rows.length; i++) if ((rows[i]?.[0] ?? "").trim() === "Mã Link") return i + 1;
  return 0;
}

const colLetter = (i: number): string => (i < 26 ? "" : colLetter(Math.floor(i / 26) - 1)) + String.fromCharCode(65 + (i % 26));

// Bảng màu cố định để tô theo ngày ship - cùng 1 chuỗi ngày luôn ra cùng 1 màu (ổn định qua nhiều lần sync),
// khác ngày thì (hầu hết) ra màu khác, giúp nhìn sheet là gom được lô hàng ship chung ngày mà không cần đọc chữ.
const DATE_COLORS = [
  { red: 0.80, green: 0.93, blue: 0.80 }, { red: 1, green: 0.85, blue: 0.6 }, { red: 0.88, green: 0.80, blue: 0.95 },
  { red: 1, green: 0.95, blue: 0.6 }, { red: 0.70, green: 0.85, blue: 0.95 }, { red: 1, green: 0.80, blue: 0.85 },
  { red: 0.85, green: 0.95, blue: 0.70 }, { red: 0.95, green: 0.80, blue: 0.70 }, { red: 0.75, green: 0.95, blue: 0.90 },
  { red: 0.90, green: 0.90, blue: 0.75 },
];
function colorForDate(dateStr: string): { red: number; green: number; blue: number } {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  return DATE_COLORS[h % DATE_COLORS.length];
}

// Dò đúng cột (0-based) của từng field theo TÊN tiêu đề thực tế ở dòng header - khách chèn/xóa/đổi vị trí cột
// tùy ý vẫn ghi đúng, vì không dựa vào vị trí cố định A→N nữa. Field nào khách không có cột thì bỏ qua, không ghi.
async function readHeaderColumns(sid: string, tab: string, headerRow: number): Promise<Map<FieldKey, number>> {
  const data = (await apiSheet(sid, `/values/${encodeURIComponent(tab)}!${headerRow}:${headerRow}`, "GET")) as { values?: string[][] };
  const cells = data.values?.[0] ?? [];
  const map = new Map<FieldKey, number>();
  const byText = new Map<string, number>();
  cells.forEach((v, i) => { const t = (v ?? "").trim(); if (t && !byText.has(t)) byText.set(t, i); });
  for (const [key, label] of Object.entries(FIELD_HEADER) as [FieldKey, string][]) {
    const i = byText.get(label);
    if (i != null) map.set(key, i);
  }
  return map;
}

// Nối tiếp sync theo từng khách (tránh race khi tạo nhiều đơn liên tiếp ghi đè nhau)
const syncLocks = new Map<string, Promise<void>>();
export function syncCustomerOrders(customerId: string): Promise<void> {
  const prev = syncLocks.get(customerId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runCustomerSync(customerId));
  syncLocks.set(customerId, next);
  void next.finally(() => { if (syncLocks.get(customerId) === next) syncLocks.delete(customerId); });
  return next;
}

// ===== Quét file kho (bên đóng hàng): mã trùng tracking -> set "Đóng hàng về" (cam) =====
// Tên tab kiểu "26.6" / "8.6" = ngày.tháng -> ngày đóng. Bỏ tab không phải ngày (vd "TRANG MẪU").
function tabDate(title: string): Date | null {
  const m = title.trim().match(/^0*(\d{1,2})[.\/-]0*(\d{1,2})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const dt = new Date(new Date().getFullYear(), mo - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

// Mã tracking hợp lệ: không rỗng, không có dấu cách, >= 8 ký tự chữ-số (bỏ "0", tiêu đề, GK/GH...)
function isTrackingCode(v: string): boolean {
  const c = (v ?? "").trim();
  return c.length >= 8 && /^[A-Za-z0-9._-]+$/.test(c);
}

// Tự tạo/tìm Carton (kiện) theo BILL + Số thùng - dùng chung cho cả quét cron lẫn webhook tức thì.
// Chuẩn hóa hoa/thường (kho gõ lúc "GA" lúc "ga") -> tránh tách thành 2 kiện khác nhau cho cùng 1 kiện thực.
async function resolveCartonId(bill: string, thung: string, date: Date | null): Promise<string | null> {
  const code = `${bill} ${thung}`.trim().toUpperCase();
  if (!code) return null;
  let carton = await prisma.carton.findFirst({ where: { code, packedDate: date } });
  if (!carton) carton = await prisma.carton.create({ data: { id: uuid(), code, packedDate: date } });
  return carton.id;
}

// Checkbox "Đã xử lý" đọc formatted value -> tùy locale bảng tính có thể ra "TRUE" hoặc "ĐÚNG" (đã tick), chấp nhận vài biến thể
function isChecked(v: string): boolean {
  const s = (v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "ĐÚNG" || s === "1";
}

// Đọc mọi tab-ngày của file kho: cột A = BILL, B = Số thùng, E = mã tracking, ngày đóng = ngày của tab.
// Dùng batchGet gộp nhiều tab/1 request (file kho có thể >100 tab -> tránh 429 rate limit).
export async function readWarehousePackRows(sid: string, recentDays?: number): Promise<{ code: string; date: Date | null; tab: string; row: number; sheetId: number; bill: string; thung: string; sheetName: string; resolved: boolean }[]> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties(title,sheetId)`, "GET")) as { sheets?: { properties: { title: string; sheetId: number } }[] };
  let dateTabs = (meta.sheets ?? [])
    .map((s) => ({ title: s.properties.title, sheetId: s.properties.sheetId, date: tabDate(s.properties.title) }))
    .filter((t): t is { title: string; sheetId: number; date: Date } => t.date != null);
  // Chỉ quét tab gần đây cho nhanh (webhook/cron). Tab cũ không có mã mới về.
  if (recentDays) { const cut = Date.now() - recentDays * 86400000; dateTabs = dateTabs.filter((t) => t.date.getTime() >= cut); }
  if (!dateTabs.length) return [];

  const out: { code: string; date: Date | null; tab: string; row: number; sheetId: number; bill: string; thung: string; sheetName: string; resolved: boolean }[] = [];
  const CHUNK = 50;
  for (let i = 0; i < dateTabs.length; i += CHUNK) {
    const batch = dateTabs.slice(i, i + CHUNK);
    const ranges = batch
      .map((t) => `ranges=${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'!A1:X100000`)}`)
      .join("&");
    const data = (await apiSheet(sid, `/values:batchGet?${ranges}&majorDimension=COLUMNS`, "GET")) as { valueRanges?: { values?: string[][] }[] };
    (data.valueRanges ?? []).forEach((vr, idx) => {
      const tab = batch[idx]?.title ?? "";
      const date = batch[idx]?.date ?? null;
      const sheetId = batch[idx]?.sheetId ?? 0;
      const cols = vr.values ?? []; // majorDimension=COLUMNS -> cols[0]=A(BILL) cols[1]=B(thùng) cols[4]=E(mã tracking) cols[5]=F(tên) cols[23]=X(đã xử lý)
      const billCol = cols[0] ?? [], thungCol = cols[1] ?? [], codeCol = cols[4] ?? [], nameCol = cols[5] ?? [], doneCol = cols[23] ?? [];
      codeCol.forEach((cell, j) => {
        const code = (cell ?? "").trim();
        if (isTrackingCode(code)) {
          out.push({ code, date, tab, row: j + 1, sheetId, bill: (billCol[j] ?? "").trim(), thung: (thungCol[j] ?? "").trim(), sheetName: (nameCol[j] ?? "").trim(), resolved: isChecked(doneCol[j] ?? "") });
        }
      });
    });
  }
  return out;
}

// "Vàng" do kho tự tô tay trong sheet nháp trước khi chốt nộp hải quan - không phải màu hệ thống tự ghi
// (khác PURPLE/ORANGE/GREEN/YELLOW cố định ở syncPackedFromWarehouse), nên chỉ nhận diện theo sắc thái vàng
// chứ không so khớp RGB chính xác (người dùng có thể chọn bất kỳ sắc vàng nào trong bảng màu Google Sheets).
function looksYellow(bg?: { red?: number; green?: number; blue?: number }): boolean {
  if (!bg) return false;
  const r = bg.red ?? 0, g = bg.green ?? 0, b = bg.blue ?? 0;
  return r > 0.9 && g > 0.75 && b < 0.75 && r - b > 0.15;
}

// Đọc sheet nháp kho ("invoice test") -> lấy các dòng đang tô vàng (cần lấy thuế), dùng cho tính năng
// Chứng từ hải quan. Sheet là 1 khối liên tục do kho tự đóng gói, KHÔNG lọc theo ngày - "vàng" là do kho tự
// tô tay ngay trước khi chốt nộp hải quan, độc lập với ngày hóa đơn user nhập lúc upload chứng từ.
export async function readInvoiceTaxRows(sid: string): Promise<{ trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[]> {
  if (!saEnabled()) return [];
  const meta = (await apiSheet(sid, `?fields=${encodeURIComponent("sheets.properties(title)")}`, "GET")) as { sheets?: { properties: { title: string } }[] };
  const tabs = (meta.sheets ?? []).map((s) => s.properties.title);
  const fields = "sheets(data(rowData(values(formattedValue,userEnteredFormat.backgroundColor))))";
  const out: { trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[] = [];
  for (const tab of tabs) {
    const esc = tab.replace(/'/g, "''");
    const data = (await apiSheet(sid, `?ranges=${encodeURIComponent(`'${esc}'!A1:Z3000`)}&fields=${encodeURIComponent(fields)}`, "GET")) as {
      sheets?: { data?: { rowData?: { values?: { formattedValue?: string; userEnteredFormat?: { backgroundColor?: { red?: number; green?: number; blue?: number } } }[] }[] }[] }[];
    };
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

function fillToRgb01(
  fill: { type?: string; fgColor?: { argb?: string; indexed?: number } } | undefined,
  palette: string[],
): { red: number; green: number; blue: number } | undefined {
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

// Đọc file Excel chứng từ GA do người dùng upload trực tiếp (thay vì Google Sheet cấu hình sẵn) -> cùng
// quy tắc nhận diện với readInvoiceTaxRows: dò cột "TRACKING", lấy dòng có ô mã tracking tô vàng.
// Sheet không có cột TRACKING (vd file hải quan GB.xxx chỉ có Tên hàng + Giá) -> fallback quét theo TÊN
// (trackingCode=null), matchTaxRows sẽ thử khớp tên với OrderItem - kém chắc chắn hơn khớp mã, cần xác nhận lại.
export async function readInvoiceTaxRowsFromExcel(buffer: Buffer): Promise<{ trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  const palette = await loadIndexedPalette(buffer);
  const out: { trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[] = [];
  wb.eachSheet((sheet) => {
    let trackingCol = -1, nameCol = -1, priceCol = -1, billCol = -1, headerRow = -1;
    for (let r = 1; r <= sheet.rowCount && headerRow < 0; r++) {
      const row = sheet.getRow(r);
      for (let c = 1; c <= row.cellCount; c++) {
        if (safeText(row.getCell(c)).toUpperCase().includes("TRACKING")) { trackingCol = c; headerRow = r; break; }
      }
    }
    if (trackingCol >= 0) {
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
        const fill = codeCell.fill as { type?: string; fgColor?: { argb?: string; indexed?: number } } | undefined;
        if (!looksYellow(fillToRgb01(fill, palette))) continue;
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
      return;
    }
    // Không có cột TRACKING -> tìm cột Tên hàng + Giá, quét dòng tô vàng trên cột Tên hàng (fallback khớp tên).
    let nameHeaderRow = -1;
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
      const fill = nameCell.fill as { type?: string; fgColor?: { argb?: string; indexed?: number } } | undefined;
      if (!looksYellow(fillToRgb01(fill, palette))) continue;
      const priceRaw = safeText(row.getCell(priceCol)).replace(/[^\d.-]/g, "");
      out.push({ trackingCode: null, itemName, price: priceRaw ? Number(priceRaw) : null, bill: invoiceNo });
    }
  });
  return out;
}

// Quét file kho -> tracking nào trùng & chưa đóng thì set packedAt (cam). Trả số khớp / số cập nhật.
export async function syncPackedFromWarehouse(opts?: { recentDays?: number }): Promise<{ matched: number; updated: number }> {
  if (!saEnabled()) return { matched: 0, updated: 0 };
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return { matched: 0, updated: 0 };
  const rows = await readWarehousePackRows(sid, opts?.recentDays);

  // Ngày đã "chốt" khai hải quan -> mã quét vào ngày đó (kể cả mồ côi) đánh dấu lateAfterLock, cần khai bổ sung riêng
  const lockedDates = new Set((await prisma.packDayLock.findMany({ select: { date: true } })).map((l) => l.date.toISOString().slice(0, 10)));
  const isLocked = (d: Date | null) => (d ? lockedDates.has(new Date(d).toISOString().slice(0, 10)) : false);

  // Kho sửa mã khác HOẶC XÓA HẲN mã ở đúng dòng vật lý cũ trước khi chốt ngày -> tracking mã CŨ không còn khớp
  // dòng đó nữa, coi như "gỡ khỏi Kho VN" (mồ côi thì xóa hẳn, đã gắn đơn thì chỉ gỡ đóng gói) để khỏi hiện thông
  // tin cũ không còn đúng thực tế. Dòng bị xóa trắng thì không còn nằm trong `rows` (isTrackingCode lọc bỏ) nên
  // phải so trên MỌI tracking từng có packRow trong đúng khung ngày đang quét, không chỉ những dòng còn mã hợp lệ.
  // Ngày ĐÃ chốt thì KHÔNG tự dọn nữa - sửa gì cũng phải khai bổ sung thủ công.
  {
    const cutoff = opts?.recentDays ? new Date(Date.now() - opts.recentDays * 86400000) : null;
    const packRowCandidates = await prisma.tracking.findMany({ where: { packRow: { not: null }, ...(cutoff ? { packedAt: { gte: cutoff } } : {}) } });
    const claimByRowDay = new Map<string, typeof packRowCandidates>();
    for (const cand of packRowCandidates) {
      if (cand.packRow == null || !cand.packedAt) continue;
      const key = `${new Date(cand.packedAt).toISOString().slice(0, 10)}|${cand.packRow}`;
      const arr = claimByRowDay.get(key) ?? [];
      arr.push(cand);
      claimByRowDay.set(key, arr);
    }
    const currentCodeByKey = new Map<string, string>();
    // sheetId/tên tab của tab ngày đó - lấy từ bất kỳ dòng hợp lệ nào cùng tab (cả tab chỉ 1 sheetId) để biết
    // đường dẫn ghi lại màu/giá trị cho đúng dòng đã xóa trắng (dòng đó không còn trong `rows` để tự có sẵn).
    const sheetInfoByDay = new Map<string, { sheetId: number; tab: string }>();
    for (const r of rows) {
      if (!r.date) continue;
      const dk = r.date.toISOString().slice(0, 10);
      currentCodeByKey.set(`${dk}|${r.row}`, r.code);
      if (!sheetInfoByDay.has(dk)) sheetInfoByDay.set(dk, { sheetId: r.sheetId, tab: r.tab });
    }
    const blankedRows: { sheetId: number; tab: string; row: number }[] = [];
    for (const [key, cands] of claimByRowDay) {
      const dayKey = key.split("|")[0];
      if (lockedDates.has(dayKey)) continue;
      const currentCode = currentCodeByKey.get(key);
      const stale = cands.filter((s) => s.code !== currentCode);
      for (const s of stale) {
        if (s.orderId) {
          await prisma.tracking.update({ where: { id: s.id }, data: { packedAt: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, packRow: null } });
        } else {
          await prisma.trackingLog.deleteMany({ where: { trackingId: s.id } });
          await prisma.tracking.delete({ where: { id: s.id } });
        }
        // Kiện hết sạch tracking sau khi gỡ -> tự xóa luôn, khỏi để kiện trống gây rối bảng Kho VN.
        await deleteCartonIfEmpty(s.cartonId);
      }
      // Dòng bị xóa trắng hẳn (không đổi sang mã khác) -> không còn trong `rows` nên vòng ghi màu/giá trị bên dưới
      // sẽ không đụng tới nó -> phải tự dọn màu + nội dung cũ ở đây, nếu không sẽ hiện màu/thông tin sai vĩnh viễn.
      if (currentCode === undefined && stale.length) {
        const info = sheetInfoByDay.get(dayKey);
        const row = Number(key.split("|")[1]);
        if (info) blankedRows.push({ sheetId: info.sheetId, tab: info.tab, row });
      }
    }
    if (blankedRows.length) {
      try {
        const WHITE = { red: 1, green: 1, blue: 1 };
        // CHỈ xóa đúng các cột hệ thống tự ghi (F/G tên+giá, U/V/W ghi chú/link/số trùng, X checkbox) - tuyệt đối
        // không đụng H→T vì đó là cột kho tự nhập tay riêng (Số lượng, JANCODE...), không liên quan sync.
        const clearData = blankedRows.flatMap((b) => {
          const esc = b.tab.replace(/'/g, "''");
          return [
            { range: `'${esc}'!F${b.row}:G${b.row}`, values: [["", ""]] },
            { range: `'${esc}'!U${b.row}:X${b.row}`, values: [["", "", "", ""]] },
          ];
        });
        const CW = 100;
        for (let i = 0; i < clearData.length; i += CW) await apiSheet(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data: clearData.slice(i, i + CW) });
        const colorReqs = blankedRows.flatMap((b) => [
          { repeatCell: { range: { sheetId: b.sheetId, startRowIndex: b.row - 1, endRowIndex: b.row, startColumnIndex: 0, endColumnIndex: 24 }, cell: { userEnteredFormat: { backgroundColor: WHITE } }, fields: "userEnteredFormat.backgroundColor" } },
          { setDataValidation: { range: { sheetId: b.sheetId, startRowIndex: b.row - 1, endRowIndex: b.row, startColumnIndex: 23, endColumnIndex: 24 } } },
        ]);
        for (let i = 0; i < colorReqs.length; i += CW) await apiSheet(sid, `:batchUpdate`, "POST", { requests: colorReqs.slice(i, i + CW) });
      } catch (e) {
        console.error("[gsheets] clearBlankedRows", (e as Error).message);
      }
    }
  }

  const dateByCode = new Map<string, Date | null>();
  for (const r of rows) if (!dateByCode.has(r.code)) dateByCode.set(r.code, r.date);
  const codes = [...dateByCode.keys()];
  if (!codes.length) return { matched: 0, updated: 0 };
  const trks = await prisma.tracking.findMany({ where: { code: { in: codes } }, include: { order: { include: { items: true, trackings: true } } } });

  // Mã quét được nhưng chưa có tracking nào trong hệ thống (tracking sai/chưa nhập) -> tạo mồ côi
  // để không mất dấu hàng: sẽ hiện ở /control/unmatched + board Kho VN "chưa gắn", chờ sale/buyer resolve.
  const knownCodes = new Set(trks.map((t) => t.code));
  for (const c of codes) {
    if (knownCodes.has(c)) continue;
    const packedAt = dateByCode.get(c) ?? new Date();
    const created = await prisma.tracking.create({ data: { id: uuid(), code: c, packedAt, status: "new", lateAfterLock: isLocked(packedAt), needsTax: true } });
    trks.push({ ...created, order: null } as (typeof trks)[number]);
  }

  // 1 mã có thể gắn nhiều đơn khác nhau (nhầm/gộp chuyến) -> gom theo mảng, không lấy đại diện 1 đơn
  const trksByCode = new Map<string, typeof trks>();
  for (const t of trks) { const arr = trksByCode.get(t.code) ?? []; arr.push(t); trksByCode.set(t.code, arr); }
  let updated = 0;
  const customers = new Set<string>();
  for (const t of trks) {
    if (t.packedAt) continue;
    const packedAt = dateByCode.get(t.code) ?? new Date();
    const lateAfterLock = isLocked(packedAt);
    // Mọi mã đóng hàng đều cần lấy thuế 100% - tự set needsTax ngay lúc quét kho, không cần tô vàng thủ công nữa.
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock, needsTax: true } });
    t.lateAfterLock = lateAfterLock;
    void syncTracking({ ...t, packedAt } as TrackingRow);
    updated++;
    if (t.order) { await recomputeOrderTotals(t.orderId!); customers.add(t.order.customerId); }
  }
  for (const c of customers) await syncCustomerOrders(c);

  // Tự tạo/gán Carton (kiện) theo BILL + Số thùng của từng dòng vật lý trong sheet — thay cho gán tay.
  // Tự tạo/gán lại theo đúng BILL/Thùng hiện tại trong sheet (đổi tên/số thùng thì tự theo) -
  // trừ tracking đã cartonManual (gán/gỡ kiện thủ công trong app) thì giữ nguyên, không đè.
  const cartonCache = new Map<string, string>(); // key `${code}|${dayKey}` -> cartonId
  async function getCartonId(bill: string, thung: string, date: Date | null): Promise<string | null> {
    const dayKey = date ? date.toISOString().slice(0, 10) : "none";
    const cacheKey = `${bill} ${thung}`.trim().toUpperCase() + "|" + dayKey;
    const cached = cartonCache.get(cacheKey);
    if (cached) return cached;
    const id = await resolveCartonId(bill, thung, date);
    if (id) cartonCache.set(cacheKey, id);
    return id;
  }

  // Ghép mỗi dòng vật lý trong sheet với đúng 1 tracking riêng (theo thứ tự) — để ghi tên/giá/kiện đúng
  // từng đơn thay vì gộp chung, kể cả khi kho CHƯA quét đủ hết các dòng của mã dùng chung nhiều đơn
  // (ghép trước bấy nhiêu dòng đã có, dòng dư ra ngoài số đơn mới rơi về gộp chung để an toàn).
  const rowsByCode = new Map<string, typeof rows>();
  for (const r of rows) { const arr = rowsByCode.get(r.code) ?? []; arr.push(r); rowsByCode.set(r.code, arr); }
  const rowMatch = new Map<string, (typeof trks)[number]>(); // key `${tab}|${row}` -> tracking riêng của dòng đó

  for (const [code, group] of trksByCode) {
    const physicalRows = rowsByCode.get(code) ?? [];
    if (physicalRows.length && group.length) {
      const sortedTrks = [...group].sort((a, b) => (a.order?.code ?? "￿").localeCompare(b.order?.code ?? "￿"));
      const sortedRows = [...physicalRows].sort((a, b) => (a.tab === b.tab ? a.row - b.row : a.tab.localeCompare(b.tab)));
      const n = Math.min(sortedRows.length, sortedTrks.length);
      for (let i = 0; i < n; i++) rowMatch.set(`${sortedRows[i].tab}|${sortedRows[i].row}`, sortedTrks[i]);
    }
  }

  for (const r of rows) {
    if (!r.bill && !r.thung) continue;
    const cartonId = await getCartonId(r.bill, r.thung, r.date);
    if (!cartonId) continue;
    const single = rowMatch.get(`${r.tab}|${r.row}`);
    const targets = single ? [single] : (trksByCode.get(r.code) ?? []);
    for (const t of targets) {
      const data: { cartonId?: string; packedAt?: Date; packRow?: number } = {};
      // Tự theo đúng BILL/Thùng hiện tại trong sheet (kể cả khi kho đổi tên/số thùng sau này) -
      // trừ khi người dùng đã tự tay gán/gỡ kiện (cartonManual) thì giữ nguyên, không đè.
      if (!t.cartonManual && t.cartonId !== cartonId) data.cartonId = cartonId;
      // Ghép được đúng 1-1 với dòng vật lý -> ngày dòng đó là chuẩn; mã dùng chung nhiều ngày có thể
      // đã bị khoá packedAt theo ngày quét đầu tiên (sai), sửa lại khớp đúng kiện/ngày thật.
      if (single && r.date && t.packedAt && r.date.toISOString().slice(0, 10) !== new Date(t.packedAt).toISOString().slice(0, 10)) data.packedAt = r.date;
      if (t.packRow !== r.row) data.packRow = r.row;
      if (Object.keys(data).length) { await prisma.tracking.update({ where: { id: t.id }, data }); Object.assign(t, data); }
    }
  }

  // Ghi ngược vào file kho (cần SA quyền Editor):
  // Tên hàng (F) + Giá ¥ (G) — ghi ĐÚNG đơn của dòng đó nếu ghép được 1-1, ngược lại gộp tất cả (an toàn).
  // Nếu kho đã tự sửa tên (F khác tên hệ thống tính ra) -> không ghi đè, lưu lại customsName để dùng khi xuất hóa đơn.
  // Chú ý (U) = note gia cố/mở hàng + số dòng cần quét khi 1 mã dùng chung nhiều đơn; Link đối chiếu (V); Số trùng (W) = số món.
  // Cột X = checkbox "Đã xử lý" - kho tự tick khi đã xử lý xong (đổi tên/mở hàng/quét đủ dòng) -> tắt màu, không cần đợi hệ thống.
  // Màu dòng theo ưu tiên: đã tick X -> trắng; quét sau khi chốt ngày -> tím (cần khai bổ sung); đổi tên -> cam; trùng tracking -> xanh lá; mở hàng/gia cố -> vàng.
  try {
    const data: { range: string; values: (string | number | boolean)[][] }[] = [];
    const colorReqs: any[] = [];
    const PURPLE = { red: 0.88, green: 0.80, blue: 0.95 };
    const ORANGE = { red: 1, green: 0.85, blue: 0.6 };
    const GREEN = { red: 0.80, green: 0.93, blue: 0.80 };
    const YELLOW = { red: 1, green: 0.95, blue: 0.6 };
    const RED = { red: 1, green: 0.72, blue: 0.72 };
    const WHITE = { red: 1, green: 1, blue: 1 };
    // 1 đơn có thể nhiều món -> nhiều tracking; ghép món đúng theo VỊ TRÍ tracking đó trong đơn
    // (cùng quy ước với buildRowsByMonth: item[idx] <-> trackings[idx]), tránh lấy nhầm SANG món khác cùng đơn.
    const itemForTracking = (t: (typeof trks)[number]) => {
      const ord = t.order;
      if (!ord) return undefined;
      const idx = ord.trackings.findIndex((x) => x.id === t.id);
      return idx >= 0 ? ord.items[idx] : undefined;
    };
    for (const r of rows) {
      const single = rowMatch.get(`${r.tab}|${r.row}`);
      const group = single ? [single] : (trksByCode.get(r.code) ?? []);
      const seenOrderIds = new Set<string>();
      const orders = group.map((t) => t.order).filter((o): o is NonNullable<typeof o> => {
        if (!o || seenOrderIds.has(o.id)) return false;
        seenOrderIds.add(o.id);
        return true;
      });
      if (!orders.length) continue;
      const singleItem = single ? itemForTracking(single) : undefined;
      const items = single ? (singleItem ? [singleItem] : (single.order?.items ?? [])) : orders.flatMap((o) => o.items ?? []);
      const esc = r.tab.replace(/'/g, "''");
      const isLate = group.some((t) => t.lateAfterLock);
      if (r.resolved && isLate) for (const t of group) if (t.lateAfterLock) await prisma.tracking.update({ where: { id: t.id }, data: { lateAfterLock: false } });
      let editedByKho = false;
      if (items.length) {
        const name = items.map((i) => i.name).join(" + ");
        const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
        // Trước khi tách được 1-1 (packRow chưa gán xong), mã dùng chung nhiều đơn từng bị ghi GỘP tên+giá cả
        // nhóm (fallback an toàn). Sau khi tách được rồi, ô sheet vẫn còn đúng y tên gộp CŨ đó -> so với tên
        // MỘT món mới tính ra sẽ luôn khác -> hiểu lầm thành "kho tự sửa tên", mắc kẹt mãi không ghi đè lại được
        // dù dữ liệu gộp đó là hệ thống tự ghi, không phải kho gõ tay. Phải so thêm với tên gộp cũ để nhận diện -
        // so theo TẬP HỢP tên (không theo thứ tự nối chuỗi) vì thứ tự trả về từ DB không cố định giữa các lần chạy.
        const fullGroup = trksByCode.get(r.code) ?? [];
        const seenFullOrderIds = new Set<string>();
        const fullOrders = fullGroup.map((t) => t.order).filter((o): o is NonNullable<typeof o> => {
          if (!o || seenFullOrderIds.has(o.id)) return false;
          seenFullOrderIds.add(o.id);
          return true;
        });
        const fullNameSet = new Set(fullOrders.flatMap((o) => o.items ?? []).map((i) => i.name));
        const sheetNameSet = new Set((r.sheetName ?? "").split(" + ").map((s) => s.trim()).filter(Boolean));
        const looksLikeOldMerge = fullNameSet.size > 1 && fullNameSet.size === sheetNameSet.size && [...fullNameSet].every((n) => sheetNameSet.has(n));
        if (single && r.sheetName && r.sheetName !== name && !looksLikeOldMerge) {
          // Kho đã tự sửa tên trong sheet (vd để dễ thông quan) -> giữ nguyên, không ghi đè
          editedByKho = true;
          if (single.customsName !== r.sheetName) await prisma.tracking.update({ where: { id: single.id }, data: { customsName: r.sheetName } });
        } else {
          if (single && single.customsName) await prisma.tracking.update({ where: { id: single.id }, data: { customsName: null } });
          data.push({ range: `'${esc}'!F${r.row}:G${r.row}`, values: [[name, price]] });
        }
      }
      const dbCount = (trksByCode.get(r.code) ?? []).length;
      const scannedCount = (rowsByCode.get(r.code) ?? []).length;
      const lateNote = isLate && !r.resolved ? "Quét SAU KHI đã chốt ngày - cần khai bổ sung hải quan riêng" : "";
      const scanNote = dbCount > 1 ? `Mã dùng chung ${dbCount} đơn - đã quét ${scannedCount}/${dbCount} dòng` : "";
      // dbCount=1 nhưng mã xuất hiện >1 dòng vật lý trên sheet -> kho quét trùng tay hoặc shop cấp trùng tracking, khác case dùng chung nhiều đơn (GREEN).
      const dupScanNote = dbCount === 1 && scannedCount > 1 ? `CẢNH BÁO: mã quét trùng ${scannedCount} dòng nhưng hệ thống chỉ có 1 đơn - kiểm tra tracking trùng (shop cấp trùng hoặc quét nhầm)` : "";
      const checkNote = orders.filter((o) => o.needsCheck).map((o) => o.checkNote?.trim() || "Mở hàng / gia cố").join(" | ");
      const note = [lateNote, scanNote, dupScanNote, checkNote].filter(Boolean).join(" | ");
      const link = [...new Set(items.map((i) => i.url).filter(Boolean) as string[])].join(" ");
      // Số trùng = tổng số đơn đang dùng chung mã này (không phải số món của riêng đơn ở dòng này)
      // -> kho nhìn cột này biết cần quét/đối chiếu đủ bấy nhiêu dòng cho 1 mã.
      const count = dbCount;
      data.push({ range: `'${esc}'!U${r.row}:W${r.row}`, values: [[note, link, count]] });
      const bg = r.resolved ? WHITE : (isLate ? PURPLE : editedByKho ? ORANGE : dbCount > 1 ? GREEN : dupScanNote ? RED : checkNote ? YELLOW : WHITE);
      colorReqs.push({ repeatCell: {
        range: { sheetId: r.sheetId, startRowIndex: r.row - 1, endRowIndex: r.row, startColumnIndex: 0, endColumnIndex: 24 },
        cell: { userEnteredFormat: { backgroundColor: bg } },
        fields: "userEnteredFormat.backgroundColor",
      } });
      // Chỉ dòng có màu (cần xử lý) mới hiện checkbox "Đã xử lý"; dòng bình thường/đã xử lý xong thì bỏ checkbox, dọn sạch ô X.
      const xRange = { sheetId: r.sheetId, startRowIndex: r.row - 1, endRowIndex: r.row, startColumnIndex: 23, endColumnIndex: 24 };
      if (bg !== WHITE) {
        colorReqs.push({ setDataValidation: { range: xRange, rule: { condition: { type: "BOOLEAN" }, strict: true } } });
      } else {
        colorReqs.push({ setDataValidation: { range: xRange } });
        if (r.resolved) data.push({ range: `'${esc}'!X${r.row}`, values: [[""]] });
      }
    }
    // Ô Z1 mỗi tab: checkbox "Đã nộp hải quan" - kho tự tick để khóa ngày đó (đồng bộ 2 chiều với nút "Chốt ngày" trong app).
    const tabInfo = new Map<string, { sheetId: number; date: Date | null }>();
    for (const r of rows) if (!tabInfo.has(r.tab)) tabInfo.set(r.tab, { sheetId: r.sheetId, date: r.date });
    for (const [tab, info] of tabInfo) {
      const esc = tab.replace(/'/g, "''");
      const dayKey = info.date ? info.date.toISOString().slice(0, 10) : null;
      const lockedTab = dayKey ? lockedDates.has(dayKey) : false;
      data.push({ range: `'${esc}'!Y1`, values: [["Đã nộp hải quan (tick khi xong)"]] });
      data.push({ range: `'${esc}'!Z1`, values: [[lockedTab]] });
      colorReqs.push({ setDataValidation: { range: { sheetId: info.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 25, endColumnIndex: 26 }, rule: { condition: { type: "BOOLEAN" }, strict: true } } });
    }
    const CW = 100;
    for (let i = 0; i < data.length; i += CW) {
      await apiSheet(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data: data.slice(i, i + CW) });
    }
    for (let i = 0; i < colorReqs.length; i += CW) {
      await apiSheet(sid, `:batchUpdate`, "POST", { requests: colorReqs.slice(i, i + CW) });
    }
  } catch (e) {
    console.error("[gsheets] writeInvoiceToWarehouse", (e as Error).message);
  }

  return { matched: trks.length, updated };
}

// Kho tick checkbox Z1 của tab ngày đó ("Đã nộp hải quan") -> khóa/mở khóa ngày, dùng chung với nút "Chốt ngày" trong app.
export async function setDayLockFromTab(tab: string, locked: boolean): Promise<void> {
  const date = tabDate(tab);
  if (!date) return;
  const d = new Date(date.toISOString().slice(0, 10) + "T00:00:00");
  if (locked) await prisma.packDayLock.upsert({ where: { date: d }, update: {}, create: { date: d } });
  else await prisma.packDayLock.deleteMany({ where: { date: d } });
}

// Gỡ/xóa tracking qua APP (nút "Xóa" ở Kho VN) - không phải kho tự xóa mã trong sheet, nên cron quét file kho
// (chỉ phát hiện qua so sánh với sheet) không có cơ hội biết dòng vật lý từng chiếm cần dọn màu/nội dung nữa,
// nhất là khi packedAt bị reset về null cùng lúc (rớt khỏi cutoff recentDays) -> màu/tên/giá cũ kẹt lại vĩnh viễn
// trên file kho. Gọi hàm này NGAY lúc gỡ để tự dọn, không chờ/không có cách nào cron dọn thay được nữa.
export async function clearWarehouseRow(packedAt: Date | null, row: number | null): Promise<void> {
  if (!saEnabled() || !packedAt || row == null) return;
  try {
    const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
    const sid = cfg?.value ? parseSheetId(cfg.value) : null;
    if (!sid) return;
    const dayKey = packedAt.toISOString().slice(0, 10);
    const meta = (await apiSheet(sid, `?fields=sheets.properties(title,sheetId)`, "GET")) as { sheets?: { properties: { title: string; sheetId: number } }[] };
    const found = (meta.sheets ?? []).find((s) => tabDate(s.properties.title)?.toISOString().slice(0, 10) === dayKey);
    if (!found) return;
    const esc = found.properties.title.replace(/'/g, "''");
    await apiSheet(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data: [
      { range: `'${esc}'!F${row}:G${row}`, values: [["", ""]] },
      { range: `'${esc}'!U${row}:X${row}`, values: [["", "", "", ""]] },
    ] });
    const WHITE = { red: 1, green: 1, blue: 1 };
    await apiSheet(sid, `:batchUpdate`, "POST", { requests: [
      { repeatCell: { range: { sheetId: found.properties.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 24 }, cell: { userEnteredFormat: { backgroundColor: WHITE } }, fields: "userEnteredFormat.backgroundColor" } },
      { setDataValidation: { range: { sheetId: found.properties.sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 23, endColumnIndex: 24 } } },
    ] });
  } catch (e) {
    console.error("[gsheets] clearWarehouseRow", (e as Error).message);
  }
}

async function getSheetIdByTitle(sid: string, title: string): Promise<number | null> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties(title,sheetId)`, "GET")) as { sheets?: { properties: { title: string; sheetId: number } }[] };
  for (const s of meta.sheets ?? []) if (s.properties.title === title) return s.properties.sheetId;
  return null;
}

// TỨC THÌ: khớp đúng 1 mã (từ webhook gửi mã + tab + dòng), không quét tab nào -> nhanh <1s.
export async function syncPackedOne(code: string, tab?: string, row?: number, bill?: string, thung?: string): Promise<{ matched: boolean }> {
  if (!saEnabled()) return { matched: false };
  const c = (code ?? "").trim();
  if (!isTrackingCode(c)) return { matched: false };
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return { matched: false };
  const group = await prisma.tracking.findMany({ where: { code: c }, include: { order: { include: { items: true, trackings: true } } } });
  const packedAt = (tab ? tabDate(tab) : null) ?? group[0]?.packedAt ?? new Date();
  const locked = Boolean(await prisma.packDayLock.findUnique({ where: { date: new Date(packedAt.toISOString().slice(0, 10) + "T00:00:00") } }));

  // Kho sửa lại mã ở đúng dòng vật lý này (gõ nhầm rồi sửa mã khác) trước khi chốt ngày -> tracking mã CŨ từng
  // chiếm đúng dòng này không còn khớp nữa, gỡ khỏi Kho VN (mồ côi thì xóa hẳn) để khỏi hiện thông tin cũ sai lệch.
  // Ngày ĐÃ chốt thì không tự dọn nữa - sửa gì cũng phải khai bổ sung thủ công.
  if (row && !locked) {
    const dayKey = packedAt.toISOString().slice(0, 10);
    const stale = await prisma.tracking.findMany({ where: { packRow: row, code: { not: c } } });
    for (const s of stale) {
      if (!s.packedAt || new Date(s.packedAt).toISOString().slice(0, 10) !== dayKey) continue;
      if (s.orderId) {
        await prisma.tracking.update({ where: { id: s.id }, data: { packedAt: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, packRow: null } });
      } else {
        await prisma.trackingLog.deleteMany({ where: { trackingId: s.id } });
        await prisma.tracking.delete({ where: { id: s.id } });
      }
      await deleteCartonIfEmpty(s.cartonId);
    }
  }
  // Mã dùng chung nhiều đơn: nếu biết đúng dòng vật lý (packRow do lần quét cron trước gán) khớp tracking nào
  // thì lấy đúng cái đó, không gộp nhầm tên/giá của đơn khác cùng mã - chỉ 1 tracking thì khỏi cần phân biệt.
  let single = group.length === 1 ? group[0] : (row ? group.find((x) => x.packRow === row) : undefined);
  let t = single ?? group[0];
  if (!t) {
    // Mã quét được nhưng chưa có tracking nào trong hệ thống -> tạo mồ côi để không mất dấu hàng
    // (hiện ở /control/unmatched + board Kho VN "chưa gắn"); gán kiện theo BILL/thùng ngay bên dưới nếu có gửi kèm.
    const created = await prisma.tracking.create({ data: { id: uuid(), code: c, packedAt, status: "new", lateAfterLock: locked, needsTax: true } });
    t = { ...created, order: null } as typeof group[number];
    group.push(t);
    single = t;
  }
  // Mọi mã đóng hàng đều cần lấy thuế 100% - tự set needsTax ngay lúc kho gõ mã, không cần tô vàng thủ công nữa.
  if (!t.packedAt || !t.needsTax) {
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock: locked, needsTax: true } });
    t.lateAfterLock = locked;
    t.needsTax = true;
  }
  if (row && group.length === 1 && t.packRow !== row) await prisma.tracking.update({ where: { id: t.id }, data: { packRow: row } });

  // Gán kiện (BILL/Thùng) ngay tức thì, không đợi cron 2 phút - trừ khi tracking đã cartonManual (gán/gỡ tay).
  if ((bill || thung) && !t.cartonManual) {
    const cartonId = await resolveCartonId(bill ?? "", thung ?? "", packedAt);
    if (cartonId && t.cartonId !== cartonId) { await prisma.tracking.update({ where: { id: t.id }, data: { cartonId } }); t.cartonId = cartonId; }
  }

  const itemForTracking = (x: (typeof group)[number]) => {
    const ord = x.order;
    if (!ord) return undefined;
    const idx = ord.trackings.findIndex((y) => y.id === x.id);
    return idx >= 0 ? ord.items[idx] : undefined;
  };

  if (tab && row) {
    try {
      const esc = tab.replace(/'/g, "''");
      const seenOrderIds = new Set<string>();
      const orders = (single ? [single] : group).map((x) => x.order).filter((o): o is NonNullable<typeof o> => {
        if (!o || seenOrderIds.has(o.id)) return false;
        seenOrderIds.add(o.id);
        return true;
      });
      const singleItem = single ? itemForTracking(single) : undefined;
      const items = single ? (singleItem ? [singleItem] : (single.order?.items ?? [])) : orders.flatMap((o) => o.items ?? []);
      const target = single ?? t;
      const data: { range: string; values: (string | number)[][] }[] = [];
      // Đọc lại F (tên) + X (đã xử lý) hiện tại của dòng để không đè tên kho đã tự sửa
      const cur = (await apiSheet(sid, `/values:batchGet?ranges=${encodeURIComponent(`'${esc}'!F${row}`)}&ranges=${encodeURIComponent(`'${esc}'!X${row}`)}`, "GET")) as { valueRanges?: { values?: string[][] }[] };
      const curName = (cur.valueRanges?.[0]?.values?.[0]?.[0] ?? "").trim();
      const resolved = isChecked(cur.valueRanges?.[1]?.values?.[0]?.[0] ?? "");
      let editedByKho = false;
      if (items.length) {
        const name = items.map((i) => i.name).join(" + ");
        const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
        // Tên gộp CŨ (lúc chưa tách được 1-1) có thể còn nguyên trên sheet - so thêm để khỏi hiểu lầm thành
        // "kho tự sửa tên" rồi mắc kẹt mãi không ghi đè lại đúng tên/giá riêng từng đơn được nữa (xem gsheets.ts syncPackedFromWarehouse).
        // Dùng FULL group (không phải `orders` đã bị thu hẹp về 1 đơn khi single đã resolve) để tính đúng tên gộp cũ,
        // và so theo TẬP HỢP tên (không theo thứ tự nối chuỗi) vì thứ tự trả về từ DB không cố định giữa các lần chạy.
        const seenFullOrderIds = new Set<string>();
        const fullOrders = group.map((x) => x.order).filter((o): o is NonNullable<typeof o> => {
          if (!o || seenFullOrderIds.has(o.id)) return false;
          seenFullOrderIds.add(o.id);
          return true;
        });
        const fullNameSet = new Set(fullOrders.flatMap((o) => o.items ?? []).map((i) => i.name));
        const sheetNameSet = new Set(curName.split(" + ").map((s) => s.trim()).filter(Boolean));
        const looksLikeOldMerge = fullNameSet.size > 1 && fullNameSet.size === sheetNameSet.size && [...fullNameSet].every((n) => sheetNameSet.has(n));
        if (curName && curName !== name && !looksLikeOldMerge) {
          editedByKho = true;
          if (target.customsName !== curName) await prisma.tracking.update({ where: { id: target.id }, data: { customsName: curName } });
        } else {
          if (target.customsName) await prisma.tracking.update({ where: { id: target.id }, data: { customsName: null } });
          data.push({ range: `'${esc}'!F${row}:G${row}`, values: [[name, price]] });
        }
      }
      const dbCount = group.length;
      const isLate = locked || group.some((x) => x.lateAfterLock);
      if (resolved && isLate) for (const x of group) if (x.lateAfterLock) await prisma.tracking.update({ where: { id: x.id }, data: { lateAfterLock: false } });
      const lateNote = isLate && !resolved ? "Quét SAU KHI đã chốt ngày - cần khai bổ sung hải quan riêng" : "";
      const scanNote = dbCount > 1 ? `Mã dùng chung ${dbCount} đơn - đã quét 1/${dbCount} dòng` : "";
      const checkNote = orders.filter((o) => o.needsCheck).map((o) => o.checkNote?.trim() || "Mở hàng / gia cố").join(" | ");
      const note = [lateNote, scanNote, checkNote].filter(Boolean).join(" | ");
      const link = [...new Set(items.map((i) => i.url).filter(Boolean) as string[])].join(" ");
      // Số trùng = tổng số đơn dùng chung mã này (không phải số món của riêng đơn ở dòng này)
      const count = dbCount;
      data.push({ range: `'${esc}'!U${row}:W${row}`, values: [[note, link, count]] });
      const PURPLE = { red: 0.88, green: 0.80, blue: 0.95 };
      const ORANGE = { red: 1, green: 0.85, blue: 0.6 };
      const GREEN = { red: 0.80, green: 0.93, blue: 0.80 };
      const YELLOW = { red: 1, green: 0.95, blue: 0.6 };
      const WHITE = { red: 1, green: 1, blue: 1 };
      const bg = resolved ? WHITE : (isLate ? PURPLE : editedByKho ? ORANGE : dbCount > 1 ? GREEN : checkNote ? YELLOW : WHITE);
      if (bg === WHITE && resolved) data.push({ range: `'${esc}'!X${row}`, values: [[""]] });
      await apiSheet(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data });
      const sheetId = await getSheetIdByTitle(sid, tab);
      if (sheetId != null) {
        // Chỉ dòng có màu (cần xử lý) mới hiện checkbox "Đã xử lý"; dòng bình thường/đã xử lý xong thì bỏ checkbox.
        const xRange = { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 23, endColumnIndex: 24 };
        await apiSheet(sid, `:batchUpdate`, "POST", { requests: [
          { repeatCell: { range: { sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 24 }, cell: { userEnteredFormat: { backgroundColor: bg } }, fields: "userEnteredFormat.backgroundColor" } },
          bg !== WHITE
            ? { setDataValidation: { range: xRange, rule: { condition: { type: "BOOLEAN" }, strict: true } } }
            : { setDataValidation: { range: xRange } },
        ] });
      }
    } catch (e) { console.error("[gsheets] syncPackedOne", (e as Error).message); }
  }
  if (t.orderId) { await recomputeOrderTotals(t.orderId); const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } }); if (o) void syncCustomerOrders(o.customerId); }
  return { matched: true };
}

// Sổ thu tiền (cọc): dò đúng cột theo tiêu đề thực tế "Mã/Ngày/Tên khoản mục/Nội dung/Tiền" (khách chèn
// thêm cột ở phần đơn hàng phía trước làm cả khối này bị đẩy lệch chỗ) - không dùng vị trí cố định W:Z nữa.
// Cột "Mã" để khách tự điền. 3 ô TỔNG TT/CỌC/NỢ (H1:H3) là công thức riêng -> tự nhảy, không đụng ở đây.
function buildDepositRows(deps: { paidAt: Date; note: string | null; amountVnd: unknown }[]): (string | number)[][] {
  return deps.map((d) => [fmtDate(d.paidAt), "Thu tiền hàng", String(d.note ?? ""), Number(d.amountVnd)]);
}

async function findDepositHeader(sid: string, tab: string): Promise<{ row: number; dateCol: number; amtCol: number } | null> {
  const data = (await apiSheet(sid, `/values/${encodeURIComponent(tab)}!A1:AZ40`, "GET")) as { values?: string[][] };
  const rows = data.values ?? [];
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const idx = cells.findIndex((v) => (v ?? "").trim() === "Tên khoản mục");
    if (idx >= 1 && (cells[idx - 1] ?? "").trim() === "Ngày") {
      return { row: r + 1, dateCol: idx - 1, amtCol: idx + 2 };
    }
  }
  return null;
}

// Khóa các cột hệ thống tự ghi (Mã Link/Ngày đặt/.../TRACKING, khối TỔNG H1:H3, cột Ngày+Số tiền của sổ cọc)
// bằng Protected Range - chỉ service account được sửa, khách/staff được share file KHÔNG sửa/xóa được các ô
// này (cột khách tự thêm như "% Công" không đụng tới, vẫn tự do). Idempotent: chỉ add range nào chưa có
// (so theo `description`) - tránh add trùng mỗi lần sync (mỗi lần lưu đơn/cọc/tracking đều gọi lại).
async function protectManagedRanges(
  sid: string,
  gsid: number,
  headerRow: number,
  headerCols: Map<FieldKey, number>,
  depHeader: { row: number; dateCol: number; amtCol: number } | null,
): Promise<void> {
  if (!SA_EMAIL) return;
  const desired = new Map<string, { startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }>();
  for (const [key, col] of headerCols) desired.set(`sys:${key}`, { startRowIndex: headerRow - 1, endRowIndex: 100000, startColumnIndex: col, endColumnIndex: col + 1 });
  desired.set("sys:total", { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 });
  if (depHeader) {
    desired.set("sys:dep-date", { startRowIndex: depHeader.row - 1, endRowIndex: 100000, startColumnIndex: depHeader.dateCol, endColumnIndex: depHeader.dateCol + 1 });
    desired.set("sys:dep-amt", { startRowIndex: depHeader.row - 1, endRowIndex: 100000, startColumnIndex: depHeader.amtCol, endColumnIndex: depHeader.amtCol + 2 });
  }
  try {
    const meta = (await apiSheet(sid, `?fields=${encodeURIComponent("sheets(properties(sheetId),protectedRanges(description))")}`, "GET")) as {
      sheets?: { properties: { sheetId: number }; protectedRanges?: { description?: string }[] }[];
    };
    const existing = new Set((meta.sheets ?? []).find((s) => s.properties.sheetId === gsid)?.protectedRanges?.map((p) => p.description ?? "") ?? []);
    const reqs = [...desired].filter(([tag]) => !existing.has(tag)).map(([tag, range]) => ({
      addProtectedRange: { protectedRange: { range: { sheetId: gsid, ...range }, description: tag, warningOnly: false, editors: { users: [SA_EMAIL] } } },
    }));
    if (reqs.length) await apiSheet(sid, `:batchUpdate`, "POST", { requests: reqs });
  } catch (e) {
    console.error("[gsheets] protectManagedRanges", (e as Error).message);
  }
}

async function runCustomerSync(customerId: string, attempt = 1): Promise<void> {
  if (!saEnabled()) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer?.sheetId) return;
    const sid = customer.sheetId;
    const orders = await loadCustomerOrders(customerId);
    // Đẩy ngay khi NV ghi (kế toán xác nhận là việc nội bộ, không chờ mới lên sheet khách)
    const deposits = await prisma.customerDeposit.findMany({ where: { customerId }, orderBy: { paidAt: "asc" } });

    // 着払い/COD kho báo riêng theo từng mã tracking (nhập ở "Phải trả kho/cty") -> cộng vào cột Phụ thu đúng dòng đó
    const trackingIds = orders.flatMap((o) => o.trackings.map((t) => t.id));
    const codByTracking = new Map<string, number>();
    if (trackingIds.length) {
      const codRows = await prisma.companyCost.groupBy({ by: ["refId"], where: { kind: "chakubarai", refId: { in: trackingIds } }, _sum: { amountVnd: true } });
      for (const r of codRows) if (r.refId) codByTracking.set(r.refId, Number(r._sum.amountVnd ?? 0));
    }

    // Mỗi MÓN nhảy vào tháng theo ngày mua của chính nó
    const custShipRateVnd = customer.shipRatePerKg != null ? Number(customer.shipRatePerKg) : null;
    const rowsByMonth = buildRowsByMonth(orders, codByTracking, custShipRateVnd);
    const depsByMonth = new Map<number, typeof deposits>();
    for (const d of deposits) { const m = vnDate(d.paidAt).getUTCMonth() + 1; (depsByMonth.get(m) ?? depsByMonth.set(m, []).get(m)!).push(d); }

    // Gồm cả các tab tháng đang tồn tại -> tháng không còn dữ liệu sẽ được dọn (tránh dòng cũ ở lại khi món đổi tháng theo ngày mua)
    const existingTabs = await listMonthTabs(sid);
    const months = new Set<number>([...rowsByMonth.keys(), ...depsByMonth.keys(), ...existingTabs.keys()]);
    for (const m of months) {
      let tab = existingTabs.get(m) ?? null;
      if (!tab) { tab = `Tháng ${m}`; await ensureNamedTab(sid, tab); }
      const t = encodeURIComponent(tab);

      // ----- Đơn hàng: ghi đúng cột theo TÊN tiêu đề thực tế của khách (không theo vị trí cố định A→N) -----
      const { rows: fieldRows, jpyTotal, vndTotal } = rowsByMonth.get(m) ?? { rows: [], jpyTotal: 0, vndTotal: 0 };
      let header = await findHeaderRow(sid, tab);
      if (!header) {
        await apiSheet(sid, `/values/${t}!A1?valueInputOption=USER_ENTERED`, "PUT", { values: [ORDER_HEADER] });
        header = 1;
      }
      const start = header + 1;
      const headerCols = await readHeaderColumns(sid, tab, header);
      const gsid = await getSheetIdByTitle(sid, tab);
      for (const [key, col] of headerCols) {
        const letter = colLetter(col);
        await apiSheet(sid, `/values/${t}!${letter}${start}:${letter}100000:clear`, "POST", {});
        if (fieldRows.length) {
          const colValues = fieldRows.map((r) => [r[key] ?? ""]);
          await apiSheet(sid, `/values/${t}!${letter}${start}?valueInputOption=USER_ENTERED`, "PUT", { majorDimension: "ROWS", values: colValues });
        }
      }

      // ----- Tô nền: "lưu kho" cam khi đang lưu kho (tự trắng khi ship), "Ngày giao" tô theo màu riêng từng ngày -----
      if (gsid != null && (headerCols.has("stored") || headerCols.has("deliveredAt"))) {
        const ORANGE = { red: 1, green: 0.85, blue: 0.6 };
        const WHITE = { red: 1, green: 1, blue: 1 };
        const reqs: unknown[] = [];
        const clearCol = (col: number) => reqs.push({ repeatCell: { range: { sheetId: gsid, startRowIndex: start - 1, endRowIndex: start + 499, startColumnIndex: col, endColumnIndex: col + 1 }, cell: { userEnteredFormat: { backgroundColor: WHITE } }, fields: "userEnteredFormat.backgroundColor" } });
        const paintCell = (col: number, i: number, bg: { red: number; green: number; blue: number }) =>
          reqs.push({ repeatCell: { range: { sheetId: gsid, startRowIndex: start - 1 + i, endRowIndex: start + i, startColumnIndex: col, endColumnIndex: col + 1 }, cell: { userEnteredFormat: { backgroundColor: bg } }, fields: "userEnteredFormat.backgroundColor" } });

        const storedCol = headerCols.get("stored");
        if (storedCol != null) {
          clearCol(storedCol);
          fieldRows.forEach((r, i) => { if (r.stored === "lưu kho") paintCell(storedCol, i, ORANGE); });
        }
        const deliveredCol = headerCols.get("deliveredAt");
        if (deliveredCol != null) {
          clearCol(deliveredCol);
          fieldRows.forEach((r, i) => { if (typeof r.deliveredAt === "string" && r.deliveredAt) paintCell(deliveredCol, i, colorForDate(r.deliveredAt)); });
        }
        await apiSheet(sid, `:batchUpdate`, "POST", { requests: reqs });
      }

      // ----- Sổ thu tiền (cọc): dò đúng cột theo tiêu đề thực tế, để trống cột Mã -----
      const monthDeposits = depsByMonth.get(m) ?? [];
      const depHeader = await findDepositHeader(sid, tab);
      if (depHeader) {
        const depStart = depHeader.row + 1;
        const c0 = colLetter(depHeader.dateCol);
        const c1 = colLetter(depHeader.amtCol);
        await apiSheet(sid, `/values/${t}!${c0}${depStart}:${c1}100000:clear`, "POST", {});
        if (monthDeposits.length) {
          const depRows = buildDepositRows(monthDeposits);
          await apiSheet(sid, `/values/${t}!${c0}${depStart}?valueInputOption=USER_ENTERED`, "PUT", { values: depRows });
        }
      }

      // ----- Khóa các cột hệ thống tự ghi - khách/staff share file không sửa/xóa được, chỉ hệ thống ghi -----
      if (gsid != null) await protectManagedRanges(sid, gsid, header, headerCols, depHeader);

      // ----- Khối TỔNG TT/CỌC/NỢ (H1/H2/H3): có tỉ giá -> thay hẳn sang ₫; không có -> giữ nguyên ¥ -----
      const jpyDepositTotal = monthDeposits.filter((d) => d.currency === "JPY").reduce((s, d) => s + Number(d.amountOrig), 0);
      const vndDepositTotal = monthDeposits.filter((d) => d.currency === "VND").reduce((s, d) => s + Number(d.amountVnd), 0);
      const useVnd = vndTotal > 0;
      const h1 = useVnd ? vndTotal : jpyTotal;
      const h2 = useVnd ? vndDepositTotal : jpyDepositTotal;
      const h3 = h1 - h2;
      await apiSheet(sid, `/values/${t}!H1:H3?valueInputOption=USER_ENTERED`, "PUT", { majorDimension: "COLUMNS", values: [[h1 || "", h2 || "", h3 || ""]] });
      // Dọn ô "Tổng/Nợ quy đổi ₫" cũ (bản trước ghi ở I:J, giờ gộp thẳng vào H nên không cần nữa)
      await apiSheet(sid, `/values/${t}!I1:J3:clear`, "POST", {});
      if (gsid != null) {
        const pattern = useVnd ? "#,##0 \"₫\"" : "\"¥\"#,##0";
        const cell = { userEnteredFormat: { numberFormat: { type: "NUMBER" as const, pattern } } };
        await apiSheet(sid, `:batchUpdate`, "POST", { requests: [
          { repeatCell: { range: { sheetId: gsid, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 }, cell, fields: "userEnteredFormat.numberFormat" } },
        ] });
      }
    }
  } catch (e) {
    // Còn 1 phần dở dang (lỗi API giữa chừng) -> thử lại cả lượt sync 1 lần, tránh để lại dữ liệu cũ trên sheet khách
    if (attempt < 2) {
      console.error("[gsheets] syncCustomerOrders retry", (e as Error).message);
      await sleep(3000);
      return runCustomerSync(customerId, attempt + 1);
    }
    console.error("[gsheets] syncCustomerOrders", (e as Error).message);
  }
}
