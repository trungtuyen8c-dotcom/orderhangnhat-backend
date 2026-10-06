import type { OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

// Nguồn sự thật duy nhất cho Order.status. Mọi chỗ ghi status (module orders + sự kiện kho) đi qua file này.

export const ORDER_STATUSES = [
  "draft", "quoted", "deposited", "purchasing", "purchased", "jp_warehouse",
  "customs", "tax_done", "vn_warehouse", "delivered", "completed", "closed", "cancelled",
] as const satisfies readonly OrderStatus[];

// Đúng thứ tự tiến trình vật lý của 1 đơn (cancelled nằm ngoài chuỗi).
export const STATUS_SEQUENCE = [
  "draft", "quoted", "deposited", "purchasing", "purchased", "jp_warehouse",
  "customs", "tax_done", "vn_warehouse", "delivered", "completed", "closed",
] as const satisfies readonly OrderStatus[];
export type SequencedStatus = (typeof STATUS_SEQUENCE)[number];

// Trạng thái do người dùng tự chốt tay - sự kiện kho tự động không được ghi đè lên các trạng thái này.
export const FROZEN_STATUSES: ReadonlySet<OrderStatus> = new Set(["completed", "closed", "cancelled"]);

// Trạng thái khởi tạo theo loại đơn.
export const INITIAL_STATUS = {
  order: "quoted",
  // Hàng ký gửi (khách tự đem, chỉ vận chuyển) - hàng đã nằm ở kho VN lúc nhập.
  consignment: "vn_warehouse",
} as const satisfies Record<string, OrderStatus>;

// Sửa nội dung đơn (món/giá/kiện) chỉ khi chưa cọc.
const EDITABLE: ReadonlySet<OrderStatus> = new Set(["draft", "quoted"]);
export const isEditable = (s: OrderStatus) => EDITABLE.has(s);

export type TransitionMode =
  // Nhân viên có quyền orders.update_status chọn tay trên dropdown: chọn TỰ DO mọi trạng thái (kể cả lùi lại /
  // mở lại đơn đã hủy) - quyết định nghiệp vụ từ commit 3f61f33 "chọn trạng thái tự do", dùng để sửa sai tay.
  | "manual"
  // Sự kiện vật lý ở kho (đóng gói JP, về kho VN, giao): chỉ tiến tới, không lùi, không đụng trạng thái chốt tay.
  | "system";

// Các trạng thái được phép chuyển TỰ ĐỘNG sang `target` (mọi trạng thái đứng trước, trừ trạng thái chốt tay).
export function systemSourcesFor(target: OrderStatus): OrderStatus[] {
  const idx = (STATUS_SEQUENCE as readonly string[]).indexOf(target);
  if (idx === -1) return [];
  return STATUS_SEQUENCE.slice(0, idx).filter((s) => !FROZEN_STATUSES.has(s));
}

export function canTransition(from: OrderStatus, to: OrderStatus, mode: TransitionMode): boolean {
  if (!(ORDER_STATUSES as readonly string[]).includes(to)) return false;
  if (mode === "manual") return true;
  return systemSourcesFor(to).includes(from);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, mode: TransitionMode): void {
  if (!canTransition(from, to, mode)) {
    throw AppError.invalidState(`Không chuyển được trạng thái đơn ${from} -> ${to}`, { from, to, mode });
  }
}

// API cho module khác (kho Nhật/VN, sheet sync): tự tiến Order.status theo sự kiện vật lý.
// Atomic theo điều kiện WHERE (không đọc-rồi-ghi) -> an toàn khi chạy song song. Đơn không đủ điều kiện bị bỏ qua
// im lặng (không throw) vì đây là đồng bộ nền, không phải thao tác của người dùng. Trả về số đơn đã đổi.
export async function bumpOrderStatus(
  orderIds: string | string[],
  target: SequencedStatus,
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const ids = (Array.isArray(orderIds) ? orderIds : [orderIds]).filter(Boolean);
  if (!ids.length) return 0;
  const allowedFrom = systemSourcesFor(target);
  if (!allowedFrom.length) return 0;
  const r = await db.order.updateMany({ where: { id: { in: ids }, status: { in: allowedFrom } }, data: { status: target } });
  return r?.count ?? 0;
}
