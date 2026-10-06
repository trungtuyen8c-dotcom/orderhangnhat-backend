import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import { appendValues, clearValues, ensureSheetTab, getValues, updateValues } from "../../integrations/google/googleSheets.client.js";
import { logError } from "../../infrastructure/systemLog.js";

// Đồng bộ Tracking sang 1 Google Sheet chung bằng service account.
// Bật khi có đủ env: GOOGLE_SA_EMAIL, GOOGLE_SA_PRIVATE_KEY, GSHEET_ID (GSHEET_TAB mặc định "Tracking").
const SHEET_ID = process.env.GSHEET_ID;
const TAB = process.env.GSHEET_TAB ?? "Tracking";

export const gsheetsEnabled = () => Boolean(serviceAccountEnabled() && SHEET_ID);

const HEADER = ["ID", "Mã tracking", "Tên (JP)", "Cân (kg)", "Đơn giá đ/kg", "Thành tiền VND", "Tracking VN", "Đơn (orderId)", "Trạng thái", "Cập nhật"];

export interface TrackingRow {
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
  const rows = await getValues(SHEET_ID!, TAB, "A:A");
  for (let i = 0; i < rows.length; i++) if (rows[i]?.[0] === id) return i + 1;
  return 0;
}

let tabReady = false;
async function ensureTab(): Promise<void> {
  if (tabReady) return;
  await ensureSheetTab(SHEET_ID!, TAB);
  tabReady = true;
}

async function ensureHeader(): Promise<void> {
  await ensureTab();
  const values = await getValues(SHEET_ID!, TAB, "A1:A1");
  if (!values.length) await updateValues(SHEET_ID!, TAB, "A1", { values: [HEADER] });
}

// Upsert 1 tracking. Không làm chết request nếu lỗi.
export async function syncTracking(t: TrackingRow): Promise<void> {
  if (!gsheetsEnabled()) return;
  try {
    await ensureHeader();
    const row = await findRow(t.id);
    if (row) await updateValues(SHEET_ID!, TAB, `A${row}`, { values: [rowValues(t)] });
    else await appendValues(SHEET_ID!, TAB, "A1", [rowValues(t)]);
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_sync_tracking_failed");
  }
}

// Xóa dòng (ghi trắng) khi tracking bị xóa.
export async function removeTrackingRow(id: string): Promise<void> {
  if (!gsheetsEnabled()) return;
  try {
    const row = await findRow(id);
    if (row) await clearValues(SHEET_ID!, TAB, `A${row}:J${row}`);
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_remove_tracking_row_failed");
  }
}
