import jwt from "jsonwebtoken";

// Đồng bộ Tracking sang Google Sheets bằng service account.
// Bật khi có đủ env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GSHEET_ID (GSHEET_TAB mặc định "Tracking").
const SA_EMAIL = process.env.GOOGLE_SA_EMAIL;
const SA_KEY = (process.env.GOOGLE_SA_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
const SHEET_ID = process.env.GSHEET_ID;
const TAB = process.env.GSHEET_TAB ?? "Tracking";

export const gsheetsEnabled = () => Boolean(SA_EMAIL && SA_KEY && SHEET_ID);

const HEADER = ["ID", "Mã tracking", "Tên (JP)", "Cân (kg)", "Đơn giá đ/kg", "Thành tiền VND", "Đơn (orderId)", "Trạng thái", "Cập nhật"];

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

async function api(path: string, method: string, body?: unknown) {
  const token = await getToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`GSHEET_API ${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

interface TrackingRow {
  id: string; code: string; jpName?: unknown; jpWeightKg?: unknown;
  unitPriceVndPerKg?: unknown; orderId?: unknown; status?: unknown;
}

function rowValues(t: TrackingRow): (string | number)[] {
  const kg = Number(t.jpWeightKg ?? 0);
  const unit = Number(t.unitPriceVndPerKg ?? 0);
  return [
    t.id, t.code, String(t.jpName ?? ""), kg || "", unit || "", kg * unit || "",
    String(t.orderId ?? ""), String(t.status ?? ""), new Date().toISOString(),
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
    if (row) await api(`/values/${encodeURIComponent(TAB)}!A${row}:I${row}:clear`, "POST", {});
  } catch (e) {
    console.error("[gsheets] removeTrackingRow", (e as Error).message);
  }
}
