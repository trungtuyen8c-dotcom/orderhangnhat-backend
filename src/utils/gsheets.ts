import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { prisma } from "../db.js";
import { recomputeOrderTotals } from "./orderTotals.js";

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

async function apiSheet(sid: string, path: string, method: string, body?: unknown) {
  const token = await getToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GSHEET_API ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
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
const ORDER_HEADER = [
  "Mã Link", "Ngày đặt", "ACC", "LINK đặt", "Phương thức thanh toán", "GIÁ WEB", "SHIP WEB",
  "% Công", "Tổng tiền bao gồm tiền công", "Cân-Kg", "Phụ thu", "TRACKING", "Đánh giá", "Ngày giao cho khách hàng",
];

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

// Dòng data theo TỪNG MÓN, gom theo THÁNG NGÀY MUA của chính món đó (không theo ngày tạo đơn).
// Cột A→N khớp đúng template khách: ...H=%Công, I=Tổng tiền(¥), J=Cân-Kg, K=Phụ thu, L=TRACKING, M=Đánh giá, N=Ngày giao.
// Trả map: tháng -> { rows: A→N, jpyTotal: tổng ¥ (mirror cột I), vndTotal: tổng quy đổi ₫ của các món có tỉ giá }, đã sắp xếp theo ngày mua.
function buildRowsByMonth(orders: OrderFull[]): Map<number, { rows: (string | number)[][]; jpyTotal: number; vndTotal: number }> {
  const byMonth = new Map<number, { date: Date; an: (string | number)[]; jpy: number; vnd: number }[]>();
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
      bucket(m).push({
        date: purchaseDate,
        an: [
          o.items.length > 1 ? `${o.code}.${idx + 1}` : o.code,
          fmtDate(purchaseDate),
          "", String(it.url ?? ""), String(it.paymentMethod ?? ""),
          giaWeb || "", ship || "", "", giaWeb + ship,
          trk?.jpWeightKg != null ? Number(trk.jpWeightKg) : "",
          idx === 0 && surchargeVnd ? Math.round(surchargeVnd) : "",
          String(trk?.code ?? ""), String(trk?.review ?? ""), "",
        ],
        jpy: giaWeb + ship,
        vnd: rate ? Math.round((giaWeb + ship) * rate) : 0,
      });
    });
  }
  const result = new Map<number, { rows: (string | number)[][]; jpyTotal: number; vndTotal: number }>();
  for (const [m, entries] of byMonth) {
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    result.set(m, {
      rows: entries.map((e) => e.an),
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

// Quét file kho -> tracking nào trùng & chưa đóng thì set packedAt (cam). Trả số khớp / số cập nhật.
export async function syncPackedFromWarehouse(opts?: { recentDays?: number }): Promise<{ matched: number; updated: number }> {
  if (!saEnabled()) return { matched: 0, updated: 0 };
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return { matched: 0, updated: 0 };
  const rows = await readWarehousePackRows(sid, opts?.recentDays);
  const dateByCode = new Map<string, Date | null>();
  for (const r of rows) if (!dateByCode.has(r.code)) dateByCode.set(r.code, r.date);
  const codes = [...dateByCode.keys()];
  if (!codes.length) return { matched: 0, updated: 0 };
  const trks = await prisma.tracking.findMany({ where: { code: { in: codes } }, include: { order: { include: { items: true } } } });

  // Ngày đã "chốt" khai hải quan -> mã quét vào ngày đó (kể cả mồ côi) đánh dấu lateAfterLock, cần khai bổ sung riêng
  const lockedDates = new Set((await prisma.packDayLock.findMany({ select: { date: true } })).map((l) => l.date.toISOString().slice(0, 10)));
  const isLocked = (d: Date | null) => (d ? lockedDates.has(new Date(d).toISOString().slice(0, 10)) : false);

  // Mã quét được nhưng chưa có tracking nào trong hệ thống (tracking sai/chưa nhập) -> tạo mồ côi
  // để không mất dấu hàng: sẽ hiện ở /control/unmatched + board Kho VN "chưa gắn", chờ sale/buyer resolve.
  const knownCodes = new Set(trks.map((t) => t.code));
  for (const c of codes) {
    if (knownCodes.has(c)) continue;
    const packedAt = dateByCode.get(c) ?? new Date();
    const created = await prisma.tracking.create({ data: { id: uuid(), code: c, packedAt, status: "new", lateAfterLock: isLocked(packedAt) } });
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
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock } });
    t.lateAfterLock = lateAfterLock;
    void syncTracking({ ...t, packedAt } as TrackingRow);
    updated++;
    if (t.order) { await recomputeOrderTotals(t.orderId!); customers.add(t.order.customerId); }
  }
  for (const c of customers) await syncCustomerOrders(c);

  // Tự tạo/gán Carton (kiện) theo BILL + Số thùng của từng dòng vật lý trong sheet — thay cho gán tay.
  // Chỉ set cartonId khi tracking chưa có kiện, để không đè lên thao tác "Bỏ khỏi kiện" thủ công.
  const cartonCache = new Map<string, string>(); // key `${code}|${dayKey}` -> cartonId
  async function getCartonId(bill: string, thung: string, date: Date | null): Promise<string | null> {
    // Chuẩn hóa hoa/thường (kho gõ lúc "GA" lúc "ga") -> tránh tách thành 2 kiện khác nhau cho cùng 1 kiện thực.
    const code = `${bill} ${thung}`.trim().toUpperCase();
    if (!code) return null;
    const dayKey = date ? date.toISOString().slice(0, 10) : "none";
    const cacheKey = `${code}|${dayKey}`;
    const cached = cartonCache.get(cacheKey);
    if (cached) return cached;
    let carton = await prisma.carton.findFirst({ where: { code, packedDate: date } });
    if (!carton) carton = await prisma.carton.create({ data: { id: uuid(), code, packedDate: date } });
    cartonCache.set(cacheKey, carton.id);
    return carton.id;
  }

  // Ghép mỗi dòng vật lý trong sheet với đúng 1 tracking (khi số dòng khớp số tracking cùng mã) —
  // để ghi tên/giá/kiện đúng từng đơn thay vì gộp; nếu số lượng không khớp, giữ hành vi cũ (gộp) để an toàn.
  const rowsByCode = new Map<string, typeof rows>();
  for (const r of rows) { const arr = rowsByCode.get(r.code) ?? []; arr.push(r); rowsByCode.set(r.code, arr); }
  const rowMatch = new Map<string, (typeof trks)[number]>(); // key `${tab}|${row}` -> tracking riêng của dòng đó

  for (const [code, group] of trksByCode) {
    const physicalRows = rowsByCode.get(code) ?? [];
    if (physicalRows.length === group.length && group.length > 0) {
      const sortedTrks = [...group].sort((a, b) => (a.order?.code ?? "￿").localeCompare(b.order?.code ?? "￿"));
      physicalRows.forEach((r, i) => rowMatch.set(`${r.tab}|${r.row}`, sortedTrks[i]));
    }
  }

  for (const r of rows) {
    if (!r.bill && !r.thung) continue;
    const cartonId = await getCartonId(r.bill, r.thung, r.date);
    if (!cartonId) continue;
    const single = rowMatch.get(`${r.tab}|${r.row}`);
    const targets = single ? [single] : (trksByCode.get(r.code) ?? []);
    for (const t of targets) {
      const data: { cartonId?: string; packedAt?: Date } = {};
      if (!t.cartonId) data.cartonId = cartonId;
      // Ghép được đúng 1-1 với dòng vật lý -> ngày dòng đó là chuẩn; mã dùng chung nhiều ngày có thể
      // đã bị khoá packedAt theo ngày quét đầu tiên (sai), sửa lại khớp đúng kiện/ngày thật.
      if (single && r.date && t.packedAt && r.date.toISOString().slice(0, 10) !== new Date(t.packedAt).toISOString().slice(0, 10)) data.packedAt = r.date;
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
    const WHITE = { red: 1, green: 1, blue: 1 };
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
      const items = orders.flatMap((o) => o.items ?? []);
      const esc = r.tab.replace(/'/g, "''");
      const isLate = group.some((t) => t.lateAfterLock);
      if (r.resolved && isLate) for (const t of group) if (t.lateAfterLock) await prisma.tracking.update({ where: { id: t.id }, data: { lateAfterLock: false } });
      let editedByKho = false;
      if (items.length) {
        const name = items.map((i) => i.name).join(" + ");
        const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
        if (single && r.sheetName && r.sheetName !== name) {
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
      const checkNote = orders.filter((o) => o.needsCheck).map((o) => o.checkNote?.trim() || "Mở hàng / gia cố").join(" | ");
      const note = [lateNote, scanNote, checkNote].filter(Boolean).join(" | ");
      const link = [...new Set(items.map((i) => i.url).filter(Boolean) as string[])].join(" ");
      const count = items.length;
      data.push({ range: `'${esc}'!U${r.row}:W${r.row}`, values: [[note, link, count]] });
      const bg = r.resolved ? WHITE : (isLate ? PURPLE : editedByKho ? ORANGE : dbCount > 1 ? GREEN : checkNote ? YELLOW : WHITE);
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

async function getSheetIdByTitle(sid: string, title: string): Promise<number | null> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties(title,sheetId)`, "GET")) as { sheets?: { properties: { title: string; sheetId: number } }[] };
  for (const s of meta.sheets ?? []) if (s.properties.title === title) return s.properties.sheetId;
  return null;
}

// TỨC THÌ: khớp đúng 1 mã (từ webhook gửi mã + tab + dòng), không quét tab nào -> nhanh <1s.
export async function syncPackedOne(code: string, tab?: string, row?: number): Promise<{ matched: boolean }> {
  if (!saEnabled()) return { matched: false };
  const c = (code ?? "").trim();
  if (!isTrackingCode(c)) return { matched: false };
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return { matched: false };
  const group = await prisma.tracking.findMany({ where: { code: c }, include: { order: { include: { items: true } } } });
  const packedAt = (tab ? tabDate(tab) : null) ?? group[0]?.packedAt ?? new Date();
  const locked = Boolean(await prisma.packDayLock.findUnique({ where: { date: new Date(packedAt.toISOString().slice(0, 10) + "T00:00:00") } }));
  let t = group[0];
  if (!t) {
    // Mã quét được nhưng chưa có tracking nào trong hệ thống -> tạo mồ côi để không mất dấu hàng
    // (hiện ở /control/unmatched + board Kho VN "chưa gắn"); cron 2 phút sau sẽ gán kiện theo BILL/thùng.
    const created = await prisma.tracking.create({ data: { id: uuid(), code: c, packedAt, status: "new", lateAfterLock: locked } });
    t = { ...created, order: null } as typeof group[number];
    group.push(t);
  }
  if (!t.packedAt) { await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock: locked } }); t.lateAfterLock = locked; }

  if (tab && row) {
    try {
      const esc = tab.replace(/'/g, "''");
      const seenOrderIds = new Set<string>();
      const orders = group.map((x) => x.order).filter((o): o is NonNullable<typeof o> => {
        if (!o || seenOrderIds.has(o.id)) return false;
        seenOrderIds.add(o.id);
        return true;
      });
      const items = orders.flatMap((o) => o.items ?? []);
      const data: { range: string; values: (string | number)[][] }[] = [];
      // Đọc lại F (tên) + X (đã xử lý) hiện tại của dòng để không đè tên kho đã tự sửa
      const cur = (await apiSheet(sid, `/values:batchGet?ranges=${encodeURIComponent(`'${esc}'!F${row}`)}&ranges=${encodeURIComponent(`'${esc}'!X${row}`)}`, "GET")) as { valueRanges?: { values?: string[][] }[] };
      const curName = (cur.valueRanges?.[0]?.values?.[0]?.[0] ?? "").trim();
      const resolved = isChecked(cur.valueRanges?.[1]?.values?.[0]?.[0] ?? "");
      let editedByKho = false;
      if (items.length) {
        const name = items.map((i) => i.name).join(" + ");
        const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
        if (curName && curName !== name) {
          editedByKho = true;
          if (t.customsName !== curName) await prisma.tracking.update({ where: { id: t.id }, data: { customsName: curName } });
        } else {
          if (t.customsName) await prisma.tracking.update({ where: { id: t.id }, data: { customsName: null } });
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
      const count = items.length;
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

// Sổ thu tiền (cọc) cố định cột W:Z, header dòng 5, data từ dòng 6. Cột V (Mã) để khách tự điền.
// W=Ngày, X=Tên khoản mục, Y=Nội dung, Z=Tiền. 3 ô TỔNG TT/CỌC/NỢ là công thức -> tự nhảy.
const DEPOSIT_START_ROW = 6;
function buildDepositRows(deps: { paidAt: Date; note: string | null; amountVnd: unknown }[]): (string | number)[][] {
  return deps.map((d) => [fmtDate(d.paidAt), "Thu tiền hàng", String(d.note ?? ""), Number(d.amountVnd)]);
}

async function runCustomerSync(customerId: string): Promise<void> {
  if (!saEnabled()) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer?.sheetId) return;
    const sid = customer.sheetId;
    const orders = await loadCustomerOrders(customerId);
    // Đẩy ngay khi NV ghi (kế toán xác nhận là việc nội bộ, không chờ mới lên sheet khách)
    const deposits = await prisma.customerDeposit.findMany({ where: { customerId }, orderBy: { paidAt: "asc" } });

    // Mỗi MÓN nhảy vào tháng theo ngày mua của chính nó
    const rowsByMonth = buildRowsByMonth(orders);
    const depsByMonth = new Map<number, typeof deposits>();
    for (const d of deposits) { const m = vnDate(d.paidAt).getUTCMonth() + 1; (depsByMonth.get(m) ?? depsByMonth.set(m, []).get(m)!).push(d); }

    // Gồm cả các tab tháng đang tồn tại -> tháng không còn dữ liệu sẽ được dọn (tránh dòng cũ ở lại khi món đổi tháng theo ngày mua)
    const existingTabs = await listMonthTabs(sid);
    const months = new Set<number>([...rowsByMonth.keys(), ...depsByMonth.keys(), ...existingTabs.keys()]);
    for (const m of months) {
      let tab = existingTabs.get(m) ?? null;
      if (!tab) { tab = `Tháng ${m}`; await ensureNamedTab(sid, tab); }
      const t = encodeURIComponent(tab);

      // ----- Đơn hàng: A→N (TRACKING/Đánh giá nằm trong L,M - không đụng Q,R vì đó là "Tiền cọc" của khách) -----
      const { rows: an, jpyTotal, vndTotal } = rowsByMonth.get(m) ?? { rows: [], jpyTotal: 0, vndTotal: 0 };
      let header = await findHeaderRow(sid, tab);
      if (!header) {
        await apiSheet(sid, `/values/${t}!A1?valueInputOption=USER_ENTERED`, "PUT", { values: [ORDER_HEADER] });
        header = 1;
      }
      const start = header + 1;
      await apiSheet(sid, `/values/${t}!A${start}:N100000:clear`, "POST", {});
      if (an.length) await apiSheet(sid, `/values/${t}!A${start}?valueInputOption=USER_ENTERED`, "PUT", { values: an });

      // ----- Sổ thu tiền (cọc): W:Z, để trống cột V (Mã) -----
      const monthDeposits = depsByMonth.get(m) ?? [];
      const depRows = buildDepositRows(monthDeposits);
      await apiSheet(sid, `/values/${t}!W${DEPOSIT_START_ROW}:Z100000:clear`, "POST", {});
      if (depRows.length) await apiSheet(sid, `/values/${t}!W${DEPOSIT_START_ROW}?valueInputOption=USER_ENTERED`, "PUT", { values: depRows });

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
      const gsid = await getSheetIdByTitle(sid, tab);
      if (gsid != null) {
        const pattern = useVnd ? "#,##0 \"₫\"" : "\"¥\"#,##0";
        const cell = { userEnteredFormat: { numberFormat: { type: "NUMBER" as const, pattern } } };
        await apiSheet(sid, `:batchUpdate`, "POST", { requests: [
          { repeatCell: { range: { sheetId: gsid, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 }, cell, fields: "userEnteredFormat.numberFormat" } },
        ] });
      }
    }
  } catch (e) {
    console.error("[gsheets] syncCustomerOrders", (e as Error).message);
  }
}
