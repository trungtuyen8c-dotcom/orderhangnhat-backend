import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { backgroundRequest, clearValidationRequest, parseSheetId, quotedRange, rowRange } from "../../integrations/google/googleSheets.client.js";
import type { SheetsRequest, ValueRangeUpdate } from "../../integrations/google/google.types.js";
import { deleteCartonIfEmpty } from "../cartons/carton.service.js";

// Dùng chung cho quét file kho (cron) và khớp 1 mã (webhook).

export const TRACKING_WITH_ORDER = { order: { include: { items: true, trackings: true } } } satisfies Prisma.TrackingInclude;
export type TrackingWithOrder = Prisma.TrackingGetPayload<{ include: typeof TRACKING_WITH_ORDER }>;
type OrderWithItems = NonNullable<TrackingWithOrder["order"]>;
type OrderItem = OrderWithItems["items"][number];

// Màu dòng file kho. So sánh `bg !== WHITE` theo THAM CHIẾU -> luôn dùng đúng các hằng này.
export const PURPLE = { red: 0.88, green: 0.80, blue: 0.95 };
export const ORANGE = { red: 1, green: 0.85, blue: 0.6 };
export const GREEN = { red: 0.80, green: 0.93, blue: 0.80 };
export const YELLOW = { red: 1, green: 0.95, blue: 0.6 };
export const RED = { red: 1, green: 0.72, blue: 0.72 };
export const WHITE = { red: 1, green: 1, blue: 1 };

export const LATE_NOTE = "Quét SAU KHI đã chốt ngày - cần khai bổ sung hải quan riêng";

export async function getWarehouseSheetId(): Promise<string | null> {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  return cfg?.value ? parseSheetId(cfg.value) : null;
}

// Tự tạo/tìm Carton (kiện) theo BILL + Số thùng - dùng chung cho cả quét cron lẫn webhook tức thì.
// Chuẩn hóa hoa/thường (kho gõ lúc "GA" lúc "ga") -> tránh tách thành 2 kiện khác nhau cho cùng 1 kiện thực.
export async function resolveCartonId(bill: string, thung: string, date: Date | null): Promise<string | null> {
  const code = `${bill} ${thung}`.trim().toUpperCase();
  if (!code) return null;
  let carton = await prisma.carton.findFirst({ where: { code, packedDate: date } });
  if (!carton) carton = await prisma.carton.create({ data: { id: uuid(), code, packedDate: date } });
  return carton.id;
}

// Gỡ 1 tracking khỏi dòng kho nó từng chiếm (kho sửa/xóa mã ở dòng đó trước khi chốt ngày):
// đã gắn đơn -> chỉ gỡ đóng gói; mồ côi -> xóa hẳn. Kiện hết sạch tracking sau khi gỡ -> tự xóa luôn.
export async function unpackStaleTracking(s: { id: string; orderId: string | null; cartonId: string | null }): Promise<void> {
  if (s.orderId) {
    await prisma.tracking.update({ where: { id: s.id }, data: { packedAt: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, packRow: null } });
  } else {
    await prisma.trackingLog.deleteMany({ where: { trackingId: s.id } });
    await prisma.tracking.delete({ where: { id: s.id } });
  }
  await deleteCartonIfEmpty(s.cartonId);
}

// Các đơn (không trùng, bỏ null) của 1 nhóm tracking, giữ thứ tự xuất hiện.
export function uniqueOrders(group: TrackingWithOrder[]): OrderWithItems[] {
  const seen = new Set<string>();
  return group.map((t) => t.order).filter((o): o is OrderWithItems => {
    if (!o || seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

// 1 đơn có thể nhiều món -> nhiều tracking; ghép món đúng theo VỊ TRÍ tracking đó trong đơn
// (cùng quy ước với buildRowsByMonth: item[idx] <-> trackings[idx]), tránh lấy nhầm SANG món khác cùng đơn.
export function itemForTracking(t: TrackingWithOrder): OrderItem | undefined {
  const ord = t.order;
  if (!ord) return undefined;
  const idx = ord.trackings.findIndex((x) => x.id === t.id);
  return idx >= 0 ? ord.items[idx] : undefined;
}

// Món ghi lên dòng kho: ghép được 1-1 -> đúng món của tracking đó; ngược lại gộp mọi món của các đơn.
export function itemsForRow(single: TrackingWithOrder | undefined, orders: OrderWithItems[]): OrderItem[] {
  const singleItem = single ? itemForTracking(single) : undefined;
  return single ? (singleItem ? [singleItem] : (single.order?.items ?? [])) : orders.flatMap((o) => o.items ?? []);
}

export function itemsNameAndPrice(items: OrderItem[]): { name: string; price: number } {
  const name = items.map((i) => i.name).join(" + ");
  const price = items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy) + (i.shipJpy != null ? Number(i.shipJpy) : 0), 0);
  return { name, price };
}

// Trước khi tách được 1-1 (packRow chưa gán xong), mã dùng chung nhiều đơn từng bị ghi GỘP tên+giá cả
// nhóm (fallback an toàn). Sau khi tách được rồi, ô sheet vẫn còn đúng y tên gộp CŨ đó -> so với tên
// MỘT món mới tính ra sẽ luôn khác -> hiểu lầm thành "kho tự sửa tên", mắc kẹt mãi không ghi đè lại được
// dù dữ liệu gộp đó là hệ thống tự ghi, không phải kho gõ tay. Phải so thêm với tên gộp cũ để nhận diện -
// dùng FULL group của mã (không phải nhóm đã thu hẹp về 1 đơn) và so theo TẬP HỢP tên (không theo thứ tự
// nối chuỗi) vì thứ tự trả về từ DB không cố định giữa các lần chạy.
export function looksLikeOldMerge(fullGroup: TrackingWithOrder[], sheetName: string): boolean {
  const fullNameSet = new Set(uniqueOrders(fullGroup).flatMap((o) => o.items ?? []).map((i) => i.name));
  const sheetNameSet = new Set(sheetName.split(" + ").map((s) => s.trim()).filter(Boolean));
  return fullNameSet.size > 1 && fullNameSet.size === sheetNameSet.size && [...fullNameSet].every((n) => sheetNameSet.has(n));
}

export function checkNoteOf(orders: OrderWithItems[]): string {
  return orders.filter((o) => o.needsCheck).map((o) => o.checkNote?.trim() || "Mở hàng / gia cố").join(" | ");
}

export function linkOf(items: OrderItem[]): string {
  return [...new Set(items.map((i) => i.url).filter(Boolean) as string[])].join(" ");
}

// Cột X (checkbox "Đã xử lý") của 1 dòng.
export const xCellRange = (sheetId: number, row: number) => rowRange(sheetId, row, 23, 24);

// Dọn 1 dòng kho về trắng: CHỈ xóa đúng các cột hệ thống tự ghi (F/G tên+giá, U/V/W ghi chú/link/số trùng,
// X checkbox) - tuyệt đối không đụng H→T vì đó là cột kho tự nhập tay riêng (Số lượng, JANCODE...).
export function blankRowValueData(tab: string, row: number): ValueRangeUpdate[] {
  return [
    { range: quotedRange(tab, `F${row}:G${row}`), values: [["", ""]] },
    { range: quotedRange(tab, `U${row}:X${row}`), values: [["", "", "", ""]] },
  ];
}
export function blankRowFormatRequests(sheetId: number, row: number): SheetsRequest[] {
  return [backgroundRequest(rowRange(sheetId, row, 0, 24), WHITE), clearValidationRequest(xCellRange(sheetId, row))];
}
