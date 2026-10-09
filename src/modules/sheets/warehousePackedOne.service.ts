import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import {
  backgroundRequest, batchGetValues, batchUpdate, batchUpdateValues, checkboxValidationRequest, clearValidationRequest, getSheetIdByTitle,
  quotedRange, rowRange,
} from "../../integrations/google/googleSheets.client.js";
import type { ValueRangeUpdate } from "../../integrations/google/google.types.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { logError } from "../../infrastructure/systemLog.js";
import { syncCustomerOrders } from "./customerSheetSync.service.js";
import { createOrphanTrackingSafe } from "./orphanTracking.js";
import { isChecked, isTrackingCode, isoDay, seaTabDate, tabDate } from "./sheet.utils.js";
import {
  GREEN, LATE_NOTE, ORANGE, PURPLE, TRACKING_WITH_ORDER, WHITE, YELLOW, checkNoteOf, getWarehouseSheetId, isWarehouseReadonly, itemsForRow, itemsNameAndPrice,
  linkOf, looksLikeOldMerge, resolveCartonId, uniqueOrders, unpackStaleTracking, xCellRange, type TrackingWithOrder,
} from "./warehouseSheet.shared.js";

// Kho sửa lại mã ở đúng dòng vật lý này (gõ nhầm rồi sửa mã khác) trước khi chốt ngày -> tracking mã CŨ từng
// chiếm đúng dòng này không còn khớp nữa, gỡ khỏi Kho VN (mồ côi thì xóa hẳn) để khỏi hiện thông tin cũ sai lệch.
async function unpackOtherCodesOnRow(code: string, row: number, packedAt: Date): Promise<void> {
  const dayKey = isoDay(packedAt);
  const stale = await prisma.tracking.findMany({ where: { packRow: row, code: { not: code } } });
  for (const s of stale) {
    if (!s.packedAt || isoDay(s.packedAt) !== dayKey) continue;
    await unpackStaleTracking(s);
  }
}

// Ghi ngược đúng 1 dòng kho: tên/giá (F:G), ghi chú/link/số trùng (U:W), màu dòng + checkbox X.
async function writeBackOneRow(
  sid: string, tab: string, row: number, group: TrackingWithOrder[], single: TrackingWithOrder | undefined, t: TrackingWithOrder, locked: boolean,
): Promise<void> {
  const orders = uniqueOrders(single ? [single] : group);
  const items = itemsForRow(single, orders);
  const target = single ?? t;
  const data: ValueRangeUpdate[] = [];
  // Đọc lại F (tên) + X (đã xử lý) hiện tại của dòng để không đè tên kho đã tự sửa
  const cur = await batchGetValues(sid, [quotedRange(tab, `F${row}`), quotedRange(tab, `X${row}`)]);
  const curName = (cur[0]?.values?.[0]?.[0] ?? "").trim();
  const resolved = isChecked(cur[1]?.values?.[0]?.[0] ?? "");
  let editedByKho = false;
  if (items.length) {
    const { name, price } = itemsNameAndPrice(items);
    // Tên gộp CŨ (lúc chưa tách được 1-1) có thể còn nguyên trên sheet - so thêm (với FULL group) để khỏi hiểu lầm
    // thành "kho tự sửa tên" rồi mắc kẹt mãi không ghi đè lại đúng tên/giá riêng từng đơn được nữa.
    if (curName && curName !== name && !looksLikeOldMerge(group, curName)) {
      editedByKho = true;
      if (target.customsName !== curName) await prisma.tracking.update({ where: { id: target.id }, data: { customsName: curName } });
    } else {
      if (target.customsName) await prisma.tracking.update({ where: { id: target.id }, data: { customsName: null } });
      data.push({ range: quotedRange(tab, `F${row}:G${row}`), values: [[name, price]] });
    }
  }
  const dbCount = group.length;
  const isLate = locked || group.some((x) => x.lateAfterLock);
  if (resolved && isLate) for (const x of group) if (x.lateAfterLock) await prisma.tracking.update({ where: { id: x.id }, data: { lateAfterLock: false } });
  const lateNote = isLate && !resolved ? LATE_NOTE : "";
  const scanNote = dbCount > 1 ? `Mã dùng chung ${dbCount} đơn - đã quét 1/${dbCount} dòng` : "";
  const checkNote = checkNoteOf(orders);
  const note = [lateNote, scanNote, checkNote].filter(Boolean).join(" | ");
  const link = linkOf(items);
  // Số trùng = tổng số đơn dùng chung mã này (không phải số món của riêng đơn ở dòng này)
  const count = dbCount;
  data.push({ range: quotedRange(tab, `U${row}:W${row}`), values: [[note, link, count]] });
  const bg = resolved ? WHITE : (isLate ? PURPLE : editedByKho ? ORANGE : dbCount > 1 ? GREEN : checkNote ? YELLOW : WHITE);
  if (bg === WHITE && resolved) data.push({ range: quotedRange(tab, `X${row}`), values: [[""]] });
  await batchUpdateValues(sid, data);
  const sheetId = await getSheetIdByTitle(sid, tab);
  if (sheetId != null) {
    // Chỉ dòng có màu (cần xử lý) mới hiện checkbox "Đã xử lý"; dòng bình thường/đã xử lý xong thì bỏ checkbox.
    const xRange = xCellRange(sheetId, row);
    await batchUpdate(sid, [
      backgroundRequest(rowRange(sheetId, row, 0, 24), bg),
      bg !== WHITE ? checkboxValidationRequest(xRange) : clearValidationRequest(xRange),
    ]);
  }
}

// TỨC THÌ: khớp đúng 1 mã (từ webhook gửi mã + tab + dòng), không quét tab nào -> nhanh <1s.
export async function syncPackedOne(code: string, tab?: string, row?: number, bill?: string, thung?: string): Promise<{ matched: boolean }> {
  if (!serviceAccountEnabled()) return { matched: false };
  const c = (code ?? "").trim();
  if (!isTrackingCode(c)) return { matched: false };
  const sid = await getWarehouseSheetId();
  if (!sid) return { matched: false };
  const group: TrackingWithOrder[] = await prisma.tracking.findMany({ where: { code: c }, include: TRACKING_WITH_ORDER });
  // Tab "Biển ThángX" = đường biển, ngày = mùng 1 tháng đó (khớp với cron quét, không tạo trùng kiện).
  const seaDate = tab && !tabDate(tab) ? seaTabDate(tab) : null;
  const route: "air" | "sea" = seaDate ? "sea" : "air";
  const packedAt = (tab ? tabDate(tab) ?? seaDate : null) ?? group[0]?.packedAt ?? new Date();
  const locked = Boolean(await prisma.packDayLock.findUnique({ where: { date: new Date(packedAt.toISOString().slice(0, 10) + "T00:00:00") } }));

  // Ngày ĐÃ chốt thì không tự dọn nữa - sửa gì cũng phải khai bổ sung thủ công.
  if (row && !locked) await unpackOtherCodesOnRow(c, row, packedAt);

  // Mã dùng chung nhiều đơn: nếu biết đúng dòng vật lý (packRow do lần quét cron trước gán) khớp tracking nào
  // thì lấy đúng cái đó, không gộp nhầm tên/giá của đơn khác cùng mã - chỉ 1 tracking thì khỏi cần phân biệt.
  let single = group.length === 1 ? group[0] : (row ? group.find((x) => x.packRow === row) : undefined);
  let t = single ?? group[0];
  const readonly = await isWarehouseReadonly();
  if (!t && readonly) return { matched: false };
  if (!t) {
    // Mã quét được nhưng chưa có tracking nào trong hệ thống -> tạo mồ côi để không mất dấu hàng
    // (hiện ở /control/unmatched + board Kho VN "chưa gắn"); gán kiện theo BILL/thùng ngay bên dưới nếu có gửi kèm.
    const created = await createOrphanTrackingSafe({ id: uuid(), code: c, packedAt, status: "new", lateAfterLock: locked, needsTax: true });
    t = { ...created, order: null } as TrackingWithOrder;
    group.push(t);
    single = t;
  }
  // Mọi mã đóng hàng đều cần lấy thuế 100% - tự set needsTax ngay lúc kho gõ mã, không cần tô vàng thủ công nữa.
  if (!t.packedAt || !t.needsTax) {
    await prisma.tracking.update({ where: { id: t.id }, data: { packedAt, lateAfterLock: locked, needsTax: true } });
    t.lateAfterLock = locked;
    t.needsTax = true;
    if (t.orderId) await bumpOrderStatus(t.orderId, "jp_warehouse");
  }
  if (row && group.length === 1 && t.packRow !== row) await prisma.tracking.update({ where: { id: t.id }, data: { packRow: row } });

  // Gán kiện (BILL/Thùng) ngay tức thì, không đợi cron 2 phút - trừ khi tracking đã cartonManual (gán/gỡ tay).
  if ((bill || thung) && !t.cartonManual) {
    const cartonId = await resolveCartonId(bill ?? "", thung ?? "", packedAt, route);
    if (cartonId && t.cartonId !== cartonId) { await prisma.tracking.update({ where: { id: t.id }, data: { cartonId } }); t.cartonId = cartonId; }
  }

  if (tab && row && !readonly) {
    try { await writeBackOneRow(sid, tab, row, group, single, t, locked); }
    catch (e) { logError({ err: (e as Error).message }, "gsheets_sync_packed_one_failed"); }
  }
  if (t.orderId) {
    await recomputeOrderTotals(t.orderId);
    const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } });
    if (o) void syncCustomerOrders(o.customerId);
  }
  return { matched: true };
}
