import jwt from "jsonwebtoken";
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
  "% Công", "Tổng tiền (¥)", "Tỷ giá (Yên)", "Tổng tiền KH quy đổi", "Phụ thu- VND", "Cân-Kg", "Đơn giá vận chuyển",
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

// Tháng của đơn theo ngày đặt (món đầu) hoặc ngày tạo - theo giờ VN
function orderMonth(o: OrderFull): number {
  const d = o.items[0]?.purchaseDate ?? o.createdAt;
  return vnDate(d).getUTCMonth() + 1;
}

// Dòng data: A→N (điền vào template) + Q,R (mã tracking, đánh giá) - cùng thứ tự dòng.
function buildRows(orders: OrderFull[]): { an: (string | number)[][]; qr: string[][] } {
  const an: (string | number)[][] = [];
  const qr: string[][] = [];
  for (const o of orders) {
    const rate = Number(o.exchangeRate ?? 0);
    const surchargeVnd = o.surchargeCurrency === "JPY" ? Number(o.surchargeAmount) * rate : Number(o.surchargeAmount);
    o.items.forEach((it, idx) => {
      const giaWeb = it.qty * Number(it.unitPriceJpy);
      const ship = Number(it.shipJpy ?? 0);
      const trk = o.trackings[idx];
      an.push([
        o.items.length > 1 ? `${o.code}.${idx + 1}` : o.code,
        fmtDate(it.purchaseDate ?? o.createdAt),
        "", String(it.url ?? ""), String(it.paymentMethod ?? ""),
        giaWeb || "", ship || "", "", giaWeb + ship, rate || "",
        rate ? Math.round((giaWeb + ship) * rate) : "",
        idx === 0 && surchargeVnd ? Math.round(surchargeVnd) : "",
        trk?.jpWeightKg != null ? Number(trk.jpWeightKg) : "",
        trk?.unitPriceVndPerKg != null ? Number(trk.unitPriceVndPerKg) : "",
      ]);
      qr.push([String(trk?.code ?? ""), String(trk?.review ?? "")]);
    });
  }
  return { an, qr };
}

// Tìm tab ứng với tháng m, chấp nhận tên "7","07","tháng 7","Tháng 7","T7"...
async function findMonthTab(sid: string, m: number): Promise<string | null> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties.title`, "GET")) as { sheets?: { properties: { title: string } }[] };
  for (const s of meta.sheets ?? []) {
    const mm = s.properties.title.trim().toLowerCase().match(/^(?:tháng|thang|t)?\s*0*(\d{1,2})$/);
    if (mm && Number(mm[1]) === m) return s.properties.title;
  }
  return null;
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

// Đọc mọi tab-ngày của file kho: cột E = mã tracking, ngày đóng = ngày của tab.
// Dùng batchGet gộp nhiều tab/1 request (file kho có thể >100 tab -> tránh 429 rate limit).
export async function readWarehousePackRows(sid: string): Promise<{ code: string; date: Date | null; tab: string; row: number }[]> {
  const meta = (await apiSheet(sid, `?fields=sheets.properties.title`, "GET")) as { sheets?: { properties: { title: string } }[] };
  const dateTabs = (meta.sheets ?? [])
    .map((s) => ({ title: s.properties.title, date: tabDate(s.properties.title) }))
    .filter((t): t is { title: string; date: Date } => t.date != null);
  if (!dateTabs.length) return [];

  const out: { code: string; date: Date | null; tab: string; row: number }[] = [];
  const CHUNK = 50;
  for (let i = 0; i < dateTabs.length; i += CHUNK) {
    const batch = dateTabs.slice(i, i + CHUNK);
    const ranges = batch
      .map((t) => `ranges=${encodeURIComponent(`'${t.title.replace(/'/g, "''")}'!E1:E100000`)}`)
      .join("&");
    const data = (await apiSheet(sid, `/values:batchGet?${ranges}&majorDimension=COLUMNS`, "GET")) as { valueRanges?: { values?: string[][] }[] };
    (data.valueRanges ?? []).forEach((vr, idx) => {
      const tab = batch[idx]?.title ?? "";
      const date = batch[idx]?.date ?? null;
      const col = vr.values?.[0] ?? []; // majorDimension=COLUMNS -> values[0] là cột E
      col.forEach((cell, j) => {
        const code = (cell ?? "").trim();
        if (isTrackingCode(code)) out.push({ code, date, tab, row: j + 1 });
      });
    });
  }
  return out;
}

// Quét file kho -> tracking nào trùng & chưa đóng thì set packedAt (cam). Trả số khớp / số cập nhật.
export async function syncPackedFromWarehouse(): Promise<{ matched: number; updated: number }> {
  if (!saEnabled()) return { matched: 0, updated: 0 };
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return { matched: 0, updated: 0 };
  const rows = await readWarehousePackRows(sid);
  const dateByCode = new Map<string, Date | null>();
  for (const r of rows) if (!dateByCode.has(r.code)) dateByCode.set(r.code, r.date);
  const codes = [...dateByCode.keys()];
  if (!codes.length) return { matched: 0, updated: 0 };
  const trks = await prisma.tracking.findMany({ where: { code: { in: codes } }, include: { order: { include: { items: true } } } });
  const trkByCode = new Map(trks.map((t) => [t.code, t]));
  let updated = 0;
  const customers = new Set<string>();
  for (const t of trks) {
    if (t.packedAt) continue;
    const packedAt = dateByCode.get(t.code) ?? new Date();
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt } });
    void syncTracking({ ...t, packedAt } as TrackingRow);
    updated++;
    if (t.order) { await recomputeOrderTotals(t.orderId!); customers.add(t.order.customerId); }
  }
  for (const c of customers) await syncCustomerOrders(c);

  // Ghi ngược invoice: Tên hàng (F) + Giá ¥ (G) vào đúng dòng mã trong file kho (cần SA quyền Editor)
  try {
    const data: { range: string; values: (string | number)[][] }[] = [];
    for (const r of rows) {
      const t = trkByCode.get(r.code);
      const items = t?.order?.items ?? [];
      if (!items.length) continue;
      const name = items.map((i) => i.name).join(" + ");
      const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
      data.push({ range: `'${r.tab.replace(/'/g, "''")}'!F${r.row}:G${r.row}`, values: [[name, price]] });
    }
    const CW = 100;
    for (let i = 0; i < data.length; i += CW) {
      await apiSheet(sid, `/values:batchUpdate`, "POST", { valueInputOption: "USER_ENTERED", data: data.slice(i, i + CW) });
    }
  } catch (e) {
    console.error("[gsheets] writeInvoiceToWarehouse", (e as Error).message);
  }

  return { matched: trks.length, updated };
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

    const ordersByMonth = new Map<number, OrderFull[]>();
    for (const o of orders) { const m = orderMonth(o); (ordersByMonth.get(m) ?? ordersByMonth.set(m, []).get(m)!).push(o); }
    const depsByMonth = new Map<number, typeof deposits>();
    for (const d of deposits) { const m = vnDate(d.paidAt).getUTCMonth() + 1; (depsByMonth.get(m) ?? depsByMonth.set(m, []).get(m)!).push(d); }

    const months = new Set<number>([...ordersByMonth.keys(), ...depsByMonth.keys()]);
    for (const m of months) {
      let tab = await findMonthTab(sid, m);
      if (!tab) { tab = `Tháng ${m}`; await ensureNamedTab(sid, tab); }
      const t = encodeURIComponent(tab);

      // ----- Đơn hàng: A→N + Q,R (giữ O,P công thức) -----
      const list = ordersByMonth.get(m) ?? [];
      let header = await findHeaderRow(sid, tab);
      if (!header) {
        await apiSheet(sid, `/values/${t}!A1?valueInputOption=USER_ENTERED`, "PUT", { values: [ORDER_HEADER] });
        header = 1;
      }
      const start = header + 1;
      const { an, qr } = buildRows(list);
      await apiSheet(sid, `/values/${t}!A${start}:N100000:clear`, "POST", {});
      if (an.length) await apiSheet(sid, `/values/${t}!A${start}?valueInputOption=USER_ENTERED`, "PUT", { values: an });
      await apiSheet(sid, `/values/${t}!Q${start}:R100000:clear`, "POST", {});
      if (qr.length) await apiSheet(sid, `/values/${t}!Q${start}?valueInputOption=USER_ENTERED`, "PUT", { values: qr });

      // ----- Sổ thu tiền (cọc): W:Z, để trống cột V (Mã) -----
      const depRows = buildDepositRows(depsByMonth.get(m) ?? []);
      await apiSheet(sid, `/values/${t}!W${DEPOSIT_START_ROW}:Z100000:clear`, "POST", {});
      if (depRows.length) await apiSheet(sid, `/values/${t}!W${DEPOSIT_START_ROW}?valueInputOption=USER_ENTERED`, "PUT", { values: depRows });
    }
  } catch (e) {
    console.error("[gsheets] syncCustomerOrders", (e as Error).message);
  }
}
