import { batchGetValues, listSheets, quotedRange } from "../../integrations/google/googleSheets.client.js";
import { isChecked, isTrackingCode, tabDate } from "./sheet.utils.js";

export interface WarehousePackRow {
  code: string; date: Date | null; tab: string; row: number; sheetId: number;
  bill: string; thung: string; sheetName: string; resolved: boolean;
}

// Dòng đã xóa trắng mã (E) nhưng còn sót tên/giá (F/G) hệ thống ghi từ trước - vd dòng "thua" trong cặp quét
// trùng (RED) không có Tracking.packRow đại diện (chỉ 1 dòng/mã được lưu packRow, dòng còn lại không có nơi nào
// trong DB nhớ tới nó) nên cơ chế dọn theo packRow (xem syncPackedFromWarehouse) bỏ sót, để lại rác vĩnh viễn.
export interface WarehouseStaleBlankRow {
  date: Date | null; tab: string; row: number; sheetId: number;
}

// Đọc mọi tab-ngày của file kho: cột A = BILL, B = Số thùng, E = mã tracking, ngày đóng = ngày của tab.
// Dùng batchGet gộp nhiều tab/1 request (file kho có thể >100 tab -> tránh 429 rate limit).
export async function readWarehousePackRows(sid: string, recentDays?: number): Promise<{ rows: WarehousePackRow[]; staleBlank: WarehouseStaleBlankRow[] }> {
  let dateTabs = (await listSheets(sid))
    .map((s) => ({ title: s.title, sheetId: s.sheetId, date: tabDate(s.title) }))
    .filter((t): t is { title: string; sheetId: number; date: Date } => t.date != null);
  // Chỉ quét tab gần đây cho nhanh (webhook/cron). Tab cũ không có mã mới về.
  if (recentDays) { const cut = Date.now() - recentDays * 86400000; dateTabs = dateTabs.filter((t) => t.date.getTime() >= cut); }
  if (!dateTabs.length) return { rows: [], staleBlank: [] };

  const out: WarehousePackRow[] = [];
  const staleBlank: WarehouseStaleBlankRow[] = [];
  const CHUNK = 50;
  for (let i = 0; i < dateTabs.length; i += CHUNK) {
    const batch = dateTabs.slice(i, i + CHUNK);
    const valueRanges = await batchGetValues(sid, batch.map((t) => quotedRange(t.title, "A1:X100000")), "COLUMNS");
    valueRanges.forEach((vr, idx) => {
      const tab = batch[idx]?.title ?? "";
      const date = batch[idx]?.date ?? null;
      const sheetId = batch[idx]?.sheetId ?? 0;
      const cols = vr.values ?? []; // majorDimension=COLUMNS -> cols[0]=A(BILL) cols[1]=B(thùng) cols[4]=E(mã tracking) cols[5]=F(tên) cols[23]=X(đã xử lý)
      const billCol = cols[0] ?? [], thungCol = cols[1] ?? [], codeCol = cols[4] ?? [], nameCol = cols[5] ?? [], doneCol = cols[23] ?? [];
      codeCol.forEach((cell, j) => {
        const code = (cell ?? "").trim();
        if (isTrackingCode(code)) {
          out.push({ code, date, tab, row: j + 1, sheetId, bill: (billCol[j] ?? "").trim(), thung: (thungCol[j] ?? "").trim(), sheetName: (nameCol[j] ?? "").trim(), resolved: isChecked(doneCol[j] ?? "") });
        } else if ((nameCol[j] ?? "").trim()) {
          // Mã (E) đã bị xóa trắng nhưng tên (F) hệ thống ghi trước đó vẫn còn -> dòng rác cần dọn.
          staleBlank.push({ date, tab, row: j + 1, sheetId });
        }
      });
    });
  }
  return { rows: out, staleBlank };
}
