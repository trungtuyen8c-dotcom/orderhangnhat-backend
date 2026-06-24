import jwt from "jsonwebtoken";
import { prisma } from "../db.js";

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

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
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

// Tháng của đơn theo ngày đặt (món đầu) hoặc ngày tạo
function orderMonth(o: OrderFull): number {
  const d = o.items[0]?.purchaseDate ?? o.createdAt;
  return new Date(d).getMonth() + 1;
}

// Chỉ các dòng data A→N (không header, không summary) - điền vào template có sẵn.
function buildDataRows(orders: OrderFull[]): (string | number)[][] {
  const rows: (string | number)[][] = [];
  for (const o of orders) {
    const rate = Number(o.exchangeRate ?? 0);
    const surchargeVnd = o.surchargeCurrency === "JPY" ? Number(o.surchargeAmount) * rate : Number(o.surchargeAmount);
    o.items.forEach((it, idx) => {
      const giaWeb = it.qty * Number(it.unitPriceJpy);
      const ship = Number(it.shipJpy ?? 0);
      const trk = o.trackings[idx];
      rows.push([
        o.items.length > 1 ? `${o.code}.${idx + 1}` : o.code,
        fmtDate(it.purchaseDate ?? o.createdAt),
        "", String(it.url ?? ""), String(it.paymentMethod ?? ""),
        giaWeb || "", ship || "", "", giaWeb + ship, rate || "",
        rate ? Math.round((giaWeb + ship) * rate) : "",
        idx === 0 && surchargeVnd ? Math.round(surchargeVnd) : "",
        trk?.jpWeightKg != null ? Number(trk.jpWeightKg) : "",
        trk?.unitPriceVndPerKg != null ? Number(trk.unitPriceVndPerKg) : "",
      ]);
    });
  }
  return rows;
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

// Điền data đơn vào tab tháng (tên = số tháng) trong file khách, giữ nguyên template.
export async function syncCustomerOrders(customerId: string): Promise<void> {
  if (!saEnabled()) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer?.sheetId) return;
    const sid = customer.sheetId;
    const orders = await loadCustomerOrders(customerId);

    const byMonth = new Map<number, OrderFull[]>();
    for (const o of orders) {
      const m = orderMonth(o);
      (byMonth.get(m) ?? byMonth.set(m, []).get(m)!).push(o);
    }
    for (const [m, list] of byMonth) {
      let tab = await findMonthTab(sid, m);
      if (!tab) { tab = `Tháng ${m}`; await ensureNamedTab(sid, tab); }
      const t = encodeURIComponent(tab);
      let header = await findHeaderRow(sid, tab);
      if (!header) {
        // Tab chưa có template -> tự ghi 1 dòng tiêu đề ở dòng 1
        await apiSheet(sid, `/values/${t}!A1?valueInputOption=USER_ENTERED`, "PUT", { values: [ORDER_HEADER] });
        header = 1;
      }
      const start = header + 1;
      await apiSheet(sid, `/values/${t}!A${start}:N100000:clear`, "POST", {});
      const rows = buildDataRows(list);
      if (rows.length) await apiSheet(sid, `/values/${t}!A${start}?valueInputOption=USER_ENTERED`, "PUT", { values: rows });
    }
  } catch (e) {
    console.error("[gsheets] syncCustomerOrders", (e as Error).message);
  }
}
