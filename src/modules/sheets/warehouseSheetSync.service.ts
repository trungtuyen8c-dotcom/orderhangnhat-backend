import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import {
  backgroundRequest, batchUpdate, batchUpdateValues, checkboxValidationRequest, clearValidationRequest, listSheets, quotedRange, rowRange,
} from "../../integrations/google/googleSheets.client.js";
import type { SheetsRequest, ValueRangeUpdate } from "../../integrations/google/google.types.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { logError } from "../../infrastructure/systemLog.js";
import { syncCustomerOrders } from "./customerSheetSync.service.js";
import { createOrphanTrackingSafe } from "./orphanTracking.js";
import { isoDay, tabDate } from "./sheet.utils.js";
import { syncTracking, type TrackingRow } from "./trackingSheetSync.service.js";
import { readWarehousePackRows, type WarehousePackRow, type WarehouseStaleBlankRow } from "./warehouseSheet.reader.js";
import {
  GREEN, LATE_NOTE, ORANGE, PURPLE, RED, TRACKING_WITH_ORDER, WHITE, YELLOW, blankRowFormatRequests, blankRowValueData, checkNoteOf,
  getWarehouseSheetId, isWarehouseReadonly, itemsForRow, itemsNameAndPrice, linkOf, looksLikeOldMerge, resolveCartonId, uniqueOrders, unpackStaleTracking, xCellRange,
  type TrackingWithOrder,
} from "./warehouseSheet.shared.js";

const CW = 100;
type BlankedRow = { sheetId: number; tab: string; row: number };
type IsLocked = (d: Date | null) => boolean;

function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) { const k = key(x); const arr = m.get(k) ?? []; arr.push(x); m.set(k, arr); }
  return m;
}

async function loadLockedDates(): Promise<Set<string>> {
  return new Set((await prisma.packDayLock.findMany({ select: { date: true } })).map((l) => l.date.toISOString().slice(0, 10)));
}

// ===== B1. Dọn dòng kho đã đổi/xóa mã =====
// Kho sửa mã khác HOẶC XÓA HẲN mã ở đúng dòng vật lý cũ trước khi chốt ngày -> tracking mã CŨ không còn khớp
// dòng đó nữa, coi như "gỡ khỏi Kho VN" (mồ côi thì xóa hẳn, đã gắn đơn thì chỉ gỡ đóng gói) để khỏi hiện thông
// tin cũ không còn đúng thực tế. Dòng bị xóa trắng thì không còn nằm trong `rows` (isTrackingCode lọc bỏ) nên
// phải so trên MỌI tracking từng có packRow trong đúng khung ngày đang quét, không chỉ những dòng còn mã hợp lệ.
// Ngày ĐÃ chốt thì KHÔNG tự dọn nữa - sửa gì cũng phải khai bổ sung thủ công.
// Trả các dòng bị xóa trắng hẳn cần dọn màu/nội dung trên sheet.
async function unpackStaleRowClaims(rows: WarehousePackRow[], lockedDates: Set<string>, recentDays?: number): Promise<BlankedRow[]> {
  // Reader chỉ quét tab có 0h ngày >= mốc -> làm tròn mốc LÊN đầu ngày để chỉ xét tracking thuộc đúng các tab đã quét.
  // Không làm tròn thì tracking có giờ trong ngày biên (tab bị bỏ qua) bị coi là dòng đã xóa và bị gỡ/xóa nhầm.
  const cutoff = recentDays ? new Date(Math.ceil((Date.now() - recentDays * 86400000) / 86400000) * 86400000) : null;
  const packRowCandidates = await prisma.tracking.findMany({ where: { packRow: { not: null }, ...(cutoff ? { packedAt: { gte: cutoff } } : {}) } });
  const claimByRowDay = new Map<string, typeof packRowCandidates>();
  for (const cand of packRowCandidates) {
    if (cand.packRow == null || !cand.packedAt) continue;
    const key = `${isoDay(cand.packedAt)}|${cand.packRow}`;
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
  const blankedRows: BlankedRow[] = [];
  for (const [key, cands] of claimByRowDay) {
    const dayKey = key.split("|")[0];
    if (lockedDates.has(dayKey)) continue;
    const currentCode = currentCodeByKey.get(key);
    const stale = cands.filter((s) => s.code !== currentCode);
    for (const s of stale) await unpackStaleTracking(s);
    // Dòng bị xóa trắng hẳn (không đổi sang mã khác) -> không còn trong `rows` nên vòng ghi màu/giá trị bên dưới
    // sẽ không đụng tới nó -> phải tự dọn màu + nội dung cũ ở đây, nếu không sẽ hiện màu/thông tin sai vĩnh viễn.
    if (currentCode === undefined && stale.length) {
      const info = sheetInfoByDay.get(dayKey);
      const row = Number(key.split("|")[1]);
      if (info) blankedRows.push({ sheetId: info.sheetId, tab: info.tab, row });
    }
  }
  return blankedRows;
}

// Dòng "thua" trong cặp quét trùng mã (RED) không có Tracking.packRow đại diện nên vòng trên bỏ sót -
// dò thêm theo tên (F) còn sót dù mã (E) đã trắng, gộp vào cùng 1 lượt dọn, tránh trùng dòng đã có.
function mergeStaleBlankRows(blankedRows: BlankedRow[], staleBlank: WarehouseStaleBlankRow[], lockedDates: Set<string>): void {
  const seenBlanked = new Set(blankedRows.map((b) => `${b.tab}|${b.row}`));
  for (const b of staleBlank) {
    const dayKey = b.date ? b.date.toISOString().slice(0, 10) : null;
    if (dayKey && lockedDates.has(dayKey)) continue;
    const k = `${b.tab}|${b.row}`;
    if (seenBlanked.has(k)) continue;
    seenBlanked.add(k);
    blankedRows.push({ sheetId: b.sheetId, tab: b.tab, row: b.row });
  }
}

async function clearBlankedRows(sid: string, blankedRows: BlankedRow[]): Promise<void> {
  if (!blankedRows.length) return;
  try {
    const clearData = blankedRows.flatMap((b) => blankRowValueData(b.tab, b.row));
    await batchUpdateValues(sid, clearData, CW);
    const colorReqs = blankedRows.flatMap((b) => blankRowFormatRequests(b.sheetId, b.row));
    await batchUpdate(sid, colorReqs, CW);
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_clear_blanked_rows_failed");
  }
}

// ===== B2. Mã chưa có trong hệ thống -> tracking mồ côi =====
// Mã quét được nhưng chưa có tracking nào trong hệ thống (tracking sai/chưa nhập) -> tạo mồ côi
// để không mất dấu hàng: sẽ hiện ở /control/unmatched + board Kho VN "chưa gắn", chờ sale/buyer resolve.
async function createMissingOrphans(codes: string[], trks: TrackingWithOrder[], dateByCode: Map<string, Date | null>, isLocked: IsLocked): Promise<void> {
  const knownCodes = new Set(trks.map((t) => t.code));
  for (const c of codes) {
    if (knownCodes.has(c)) continue;
    const packedAt = dateByCode.get(c) ?? new Date();
    const created = await createOrphanTrackingSafe({ id: uuid(), code: c, packedAt, status: "new", lateAfterLock: isLocked(packedAt), needsTax: true });
    trks.push({ ...created, order: null } as TrackingWithOrder);
  }
}

// ===== B3. Đánh dấu đã đóng hàng (cam) =====
async function markNewlyPacked(trks: TrackingWithOrder[], dateByCode: Map<string, Date | null>, isLocked: IsLocked): Promise<number> {
  let updated = 0;
  const customers = new Set<string>();
  const packedOrderIds = new Set<string>();
  for (const t of trks) {
    if (t.packedAt) continue;
    const packedAt = dateByCode.get(t.code) ?? new Date();
    const lateAfterLock = isLocked(packedAt);
    // Mọi mã đóng hàng đều cần lấy thuế 100% - tự set needsTax ngay lúc quét kho, không cần tô vàng thủ công nữa.
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock, needsTax: true } });
    t.lateAfterLock = lateAfterLock;
    void syncTracking({ ...t, packedAt } as TrackingRow);
    updated++;
    if (t.order) { await recomputeOrderTotals(t.orderId!); customers.add(t.order.customerId); packedOrderIds.add(t.orderId!); }
  }
  for (const c of customers) await syncCustomerOrders(c);
  await bumpOrderStatus([...packedOrderIds], "jp_warehouse");
  return updated;
}

// ===== B4. Ghép dòng vật lý <-> tracking =====
// Ghép mỗi dòng vật lý trong sheet với đúng 1 tracking riêng (theo thứ tự) — để ghi tên/giá/kiện đúng
// từng đơn thay vì gộp chung, kể cả khi kho CHƯA quét đủ hết các dòng của mã dùng chung nhiều đơn
// (ghép trước bấy nhiêu dòng đã có, dòng dư ra ngoài số đơn mới rơi về gộp chung để an toàn).
// Trả map key `${tab}|${row}` -> tracking riêng của dòng đó.
function matchRowsToTrackings(trksByCode: Map<string, TrackingWithOrder[]>, rowsByCode: Map<string, WarehousePackRow[]>): Map<string, TrackingWithOrder> {
  const rowMatch = new Map<string, TrackingWithOrder>();
  for (const [code, group] of trksByCode) {
    const physicalRows = rowsByCode.get(code) ?? [];
    if (physicalRows.length && group.length) {
      const sortedTrks = [...group].sort((a, b) => (a.order?.code ?? "￿").localeCompare(b.order?.code ?? "￿"));
      const sortedRows = [...physicalRows].sort((a, b) => (a.tab === b.tab ? a.row - b.row : a.tab.localeCompare(b.tab)));
      const n = Math.min(sortedRows.length, sortedTrks.length);
      for (let i = 0; i < n; i++) rowMatch.set(`${sortedRows[i].tab}|${sortedRows[i].row}`, sortedTrks[i]);
    }
  }
  return rowMatch;
}

// ===== B5. Kiện (Carton) theo BILL + Số thùng =====
// Tự tạo/gán lại theo đúng BILL/Thùng hiện tại trong sheet (đổi tên/số thùng thì tự theo) -
// trừ tracking đã cartonManual (gán/gỡ kiện thủ công trong app) thì giữ nguyên, không đè.
function cachedCartonResolver() {
  const cartonCache = new Map<string, string>(); // key `${bill thung}|${dayKey}` -> cartonId
  return async (bill: string, thung: string, date: Date | null, route: "air" | "sea", declaredKg: number | null): Promise<string | null> => {
    const dayKey = date ? date.toISOString().slice(0, 10) : "none";
    const cacheKey = `${bill} ${thung}`.trim().toUpperCase() + "|" + dayKey;
    const cached = cartonCache.get(cacheKey);
    if (cached) return cached;
    const id = await resolveCartonId(bill, thung, date, route, declaredKg);
    if (id) cartonCache.set(cacheKey, id);
    return id;
  };
}

async function assignCartonsFromRows(rows: WarehousePackRow[], rowMatch: Map<string, TrackingWithOrder>, trksByCode: Map<string, TrackingWithOrder[]>): Promise<void> {
  const getCartonId = cachedCartonResolver();
  const kgByCarton = new Map<string, number>();
  for (const r of rows) { const k = `${r.tab}|${r.bill} ${r.thung}`.toUpperCase(); if (r.weightKg && !kgByCarton.has(k)) kgByCarton.set(k, r.weightKg); }
  for (const r of rows) {
    if (!r.bill && !r.thung) continue;
    // File Global: chỉ dòng có tracking của mình mới tạo kiện (không tạo kiện rác cho hàng khách khác).
    const single = rowMatch.get(`${r.tab}|${r.row}`);
    const targets = single ? [single] : (trksByCode.get(r.code) ?? []);
    if (!targets.length) continue;
    // Cân thùng nằm ở dòng đầu thùng (có thể là dòng của mã khác cùng thùng) -> lấy số đầu tiên có cân của đúng thùng đó.
    const cartonKg = kgByCarton.get(`${r.tab}|${r.bill} ${r.thung}`.toUpperCase()) ?? null;
    const cartonId = await getCartonId(r.bill, r.thung, r.date, r.route, cartonKg);
    if (!cartonId) continue;
    for (const t of targets) {
      const data: { cartonId?: string; packedAt?: Date; packRow?: number } = {};
      // Tự theo đúng BILL/Thùng hiện tại trong sheet (kể cả khi kho đổi tên/số thùng sau này) -
      // trừ khi người dùng đã tự tay gán/gỡ kiện (cartonManual) thì giữ nguyên, không đè.
      if (!t.cartonManual && t.cartonId !== cartonId) data.cartonId = cartonId;
      // Ghép được đúng 1-1 với dòng vật lý -> ngày dòng đó là chuẩn; mã dùng chung nhiều ngày có thể
      // đã bị khoá packedAt theo ngày quét đầu tiên (sai), sửa lại khớp đúng kiện/ngày thật.
      if (single && r.date && t.packedAt && r.date.toISOString().slice(0, 10) !== isoDay(t.packedAt)) data.packedAt = r.date;
      if (t.packRow !== r.row) data.packRow = r.row;
      if (Object.keys(data).length) { await prisma.tracking.update({ where: { id: t.id }, data }); Object.assign(t, data); }
    }
  }
}

// ===== B6. Ghi ngược vào file kho =====
type WriteBackCtx = {
  rowMatch: Map<string, TrackingWithOrder>;
  trksByCode: Map<string, TrackingWithOrder[]>;
  rowsByCode: Map<string, WarehousePackRow[]>;
  data: ValueRangeUpdate[];
  colorReqs: SheetsRequest[];
};

// 1 dòng vật lý: tên/giá (F:G), ghi chú/link/số trùng (U:W), màu dòng + checkbox X. Có thể cập nhật DB
// (reset lateAfterLock khi kho đã tick, lưu/xóa customsName khi kho tự sửa tên).
async function writeBackRow(r: WarehousePackRow, ctx: WriteBackCtx): Promise<void> {
  const { rowMatch, trksByCode, rowsByCode, data, colorReqs } = ctx;
  const single = rowMatch.get(`${r.tab}|${r.row}`);
  const group = single ? [single] : (trksByCode.get(r.code) ?? []);
  const orders = uniqueOrders(group);
  if (!orders.length) return;
  const items = itemsForRow(single, orders);
  const isLate = group.some((t) => t.lateAfterLock);
  if (r.resolved && isLate) for (const t of group) if (t.lateAfterLock) await prisma.tracking.update({ where: { id: t.id }, data: { lateAfterLock: false } });
  let editedByKho = false;
  if (items.length) {
    const { name, price } = itemsNameAndPrice(items);
    const oldMerge = looksLikeOldMerge(trksByCode.get(r.code) ?? [], r.sheetName ?? "");
    if (single && r.sheetName && r.sheetName !== name && !oldMerge) {
      // Kho đã tự sửa tên trong sheet (vd để dễ thông quan) -> giữ nguyên, không ghi đè
      editedByKho = true;
      if (single.customsName !== r.sheetName) await prisma.tracking.update({ where: { id: single.id }, data: { customsName: r.sheetName } });
    } else {
      if (single && single.customsName) await prisma.tracking.update({ where: { id: single.id }, data: { customsName: null } });
      data.push({ range: quotedRange(r.tab, `F${r.row}:G${r.row}`), values: [[name, price]] });
    }
  }
  const dbCount = (trksByCode.get(r.code) ?? []).length;
  const scannedCount = (rowsByCode.get(r.code) ?? []).length;
  const lateNote = isLate && !r.resolved ? LATE_NOTE : "";
  const scanNote = dbCount > 1 ? `Mã dùng chung ${dbCount} đơn - đã quét ${scannedCount}/${dbCount} dòng` : "";
  // dbCount=1 nhưng mã xuất hiện >1 dòng vật lý trên sheet -> kho quét trùng tay hoặc shop cấp trùng tracking, khác case dùng chung nhiều đơn (GREEN).
  const dupScanNote = dbCount === 1 && scannedCount > 1 ? `CẢNH BÁO: mã quét trùng ${scannedCount} dòng nhưng hệ thống chỉ có 1 đơn - kiểm tra tracking trùng (shop cấp trùng hoặc quét nhầm)` : "";
  const checkNote = checkNoteOf(orders);
  const note = [lateNote, scanNote, dupScanNote, checkNote].filter(Boolean).join(" | ");
  const link = linkOf(items);
  // Số trùng = tổng số đơn đang dùng chung mã này (không phải số món của riêng đơn ở dòng này)
  // -> kho nhìn cột này biết cần quét/đối chiếu đủ bấy nhiêu dòng cho 1 mã.
  const count = dbCount;
  data.push({ range: quotedRange(r.tab, `U${r.row}:W${r.row}`), values: [[note, link, count]] });
  const bg = r.resolved ? WHITE : (isLate ? PURPLE : editedByKho ? ORANGE : dbCount > 1 ? GREEN : dupScanNote ? RED : checkNote ? YELLOW : WHITE);
  colorReqs.push(backgroundRequest(rowRange(r.sheetId, r.row, 0, 24), bg));
  // Chỉ dòng có màu (cần xử lý) mới hiện checkbox "Đã xử lý"; dòng bình thường/đã xử lý xong thì bỏ checkbox, dọn sạch ô X.
  const xRange = xCellRange(r.sheetId, r.row);
  if (bg !== WHITE) {
    colorReqs.push(checkboxValidationRequest(xRange));
  } else {
    colorReqs.push(clearValidationRequest(xRange));
    if (r.resolved) data.push({ range: quotedRange(r.tab, `X${r.row}`), values: [[""]] });
  }
}

// Ô Z1 mỗi tab: checkbox "Đã nộp hải quan" - kho tự tick để khóa ngày đó (đồng bộ 2 chiều với nút "Chốt ngày" trong app).
function writeDayLockCells(rows: WarehousePackRow[], lockedDates: Set<string>, data: ValueRangeUpdate[], colorReqs: SheetsRequest[]): void {
  const tabInfo = new Map<string, { sheetId: number; date: Date | null }>();
  for (const r of rows) if (!tabInfo.has(r.tab)) tabInfo.set(r.tab, { sheetId: r.sheetId, date: r.date });
  for (const [tab, info] of tabInfo) {
    const dayKey = info.date ? info.date.toISOString().slice(0, 10) : null;
    const lockedTab = dayKey ? lockedDates.has(dayKey) : false;
    data.push({ range: quotedRange(tab, "Y1"), values: [["Đã nộp hải quan (tick khi xong)"]] });
    data.push({ range: quotedRange(tab, "Z1"), values: [[lockedTab]] });
    colorReqs.push(checkboxValidationRequest({ sheetId: info.sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 25, endColumnIndex: 26 }));
  }
}

// Ghi ngược vào file kho (cần SA quyền Editor):
// Tên hàng (F) + Giá ¥ (G) — ghi ĐÚNG đơn của dòng đó nếu ghép được 1-1, ngược lại gộp tất cả (an toàn).
// Nếu kho đã tự sửa tên (F khác tên hệ thống tính ra) -> không ghi đè, lưu lại customsName để dùng khi xuất hóa đơn.
// Chú ý (U) = note gia cố/mở hàng + số dòng cần quét khi 1 mã dùng chung nhiều đơn; Link đối chiếu (V); Số trùng (W) = số món.
// Cột X = checkbox "Đã xử lý" - kho tự tick khi đã xử lý xong (đổi tên/mở hàng/quét đủ dòng) -> tắt màu, không cần đợi hệ thống.
// Màu dòng theo ưu tiên: đã tick X -> trắng; quét sau khi chốt ngày -> tím (cần khai bổ sung); đổi tên -> cam; trùng tracking -> xanh lá; mở hàng/gia cố -> vàng.
async function writeBackToWarehouse(
  sid: string, rows: WarehousePackRow[], lockedDates: Set<string>,
  maps: Pick<WriteBackCtx, "rowMatch" | "trksByCode" | "rowsByCode">,
): Promise<void> {
  try {
    const ctx: WriteBackCtx = { ...maps, data: [], colorReqs: [] };
    for (const r of rows) await writeBackRow(r, ctx);
    writeDayLockCells(rows, lockedDates, ctx.data, ctx.colorReqs);
    await batchUpdateValues(sid, ctx.data, CW);
    await batchUpdate(sid, ctx.colorReqs, CW);
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_write_invoice_to_warehouse_failed");
  }
}

// Quét file kho -> tracking nào trùng & chưa đóng thì set packedAt (cam). Trả số khớp / số cập nhật.
export async function syncPackedFromWarehouse(opts?: { recentDays?: number }): Promise<{ matched: number; updated: number }> {
  if (!serviceAccountEnabled()) return { matched: 0, updated: 0 };
  const sid = await getWarehouseSheetId();
  if (!sid) return { matched: 0, updated: 0 };
  const { rows, staleBlank } = await readWarehousePackRows(sid, opts?.recentDays);

  // Ngày đã "chốt" khai hải quan -> mã quét vào ngày đó (kể cả mồ côi) đánh dấu lateAfterLock, cần khai bổ sung riêng
  const lockedDates = await loadLockedDates();
  const isLocked: IsLocked = (d) => (d ? lockedDates.has(isoDay(d)) : false);

  const readonly = await isWarehouseReadonly();
  const blankedRows = await unpackStaleRowClaims(rows, lockedDates, opts?.recentDays);
  if (!readonly) {
    mergeStaleBlankRows(blankedRows, staleBlank, lockedDates);
    await clearBlankedRows(sid, blankedRows);
  }

  const dateByCode = new Map<string, Date | null>();
  for (const r of rows) if (!dateByCode.has(r.code)) dateByCode.set(r.code, r.date);
  const codes = [...dateByCode.keys()];
  if (!codes.length) return { matched: 0, updated: 0 };
  const trks: TrackingWithOrder[] = await prisma.tracking.findMany({ where: { code: { in: codes } }, include: TRACKING_WITH_ORDER });
  // Chỉ đọc (file Global có hàng của khách khác): mã chưa có trong hệ thống KHÔNG tạo mồ côi - hàng của mình mất/sai
  // tracking sẽ lộ ra ở Kho VN khi quét mà không khớp đơn.
  if (!readonly) await createMissingOrphans(codes, trks, dateByCode, isLocked);

  // 1 mã có thể gắn nhiều đơn khác nhau (nhầm/gộp chuyến) -> gom theo mảng, không lấy đại diện 1 đơn
  const trksByCode = groupBy(trks, (t) => t.code);
  const updated = await markNewlyPacked(trks, dateByCode, isLocked);

  const rowsByCode = groupBy(rows, (r) => r.code);
  const rowMatch = matchRowsToTrackings(trksByCode, rowsByCode);
  await assignCartonsFromRows(rows, rowMatch, trksByCode);
  if (!readonly) await writeBackToWarehouse(sid, rows, lockedDates, { rowMatch, trksByCode, rowsByCode });

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
  if (!serviceAccountEnabled() || !packedAt || row == null) return;
  try {
    const sid = await getWarehouseSheetId();
    if (!sid || await isWarehouseReadonly()) return;
    const dayKey = packedAt.toISOString().slice(0, 10);
    const found = (await listSheets(sid)).find((s) => tabDate(s.title)?.toISOString().slice(0, 10) === dayKey);
    if (!found) return;
    await batchUpdateValues(sid, blankRowValueData(found.title, row));
    await batchUpdate(sid, blankRowFormatRequests(found.sheetId, row));
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_clear_warehouse_row_failed");
  }
}
