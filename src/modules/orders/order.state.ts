import type { Order, OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

// Nguồn sự thật duy nhất cho Order.status. Mọi chỗ ghi status (module orders + sự kiện kho) đi qua file này.
// 3 chế độ ghi:
//  - user:       người dùng có quyền orders.update_status, CHỈ theo bảng USER_TRANSITIONS bên dưới.
//  - system:     sự kiện vật lý ở kho/sheet (bumpOrderStatus) - ngoại lệ có chủ đích: được nhảy nhiều bước,
//                chỉ tiến tới, không bao giờ đụng completed/closed/cancelled.
//  - correction: admin/super_admin sửa sai - đặt BẤT KỲ trạng thái, bắt buộc lý do, có audit before/after.

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

// Trạng thái chốt - sự kiện kho tự động không được ghi đè lên các trạng thái này.
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

// ---- Chuyển trạng thái của người dùng (quyết định nghiệp vụ, không tự thêm luật) ----

export const ORDER_ACTIONS = [
  "quote", "deposit", "start-purchasing", "mark-purchased", "receive-jp", "start-customs",
  "complete-tax", "receive-vn", "deliver", "complete", "close", "cancel",
] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];

export const ACTION_LABEL: Record<OrderAction, string> = {
  quote: "Báo giá",
  deposit: "Xác nhận đã cọc",
  "start-purchasing": "Bắt đầu mua",
  "mark-purchased": "Đã mua xong",
  "receive-jp": "Về kho Nhật",
  "start-customs": "Bắt đầu thông quan",
  "complete-tax": "Đã xong thuế",
  "receive-vn": "Về kho VN",
  deliver: "Đã giao",
  complete: "Hoàn tất",
  close: "Đóng đơn",
  cancel: "Hủy đơn",
};

export type Transition = { action: OrderAction; from: OrderStatus; to: OrderStatus };

export const USER_TRANSITIONS: readonly Transition[] = [
  { from: "draft", action: "quote", to: "quoted" },
  { from: "quoted", action: "deposit", to: "deposited" },
  // Quyết định chủ: đơn nào cũng được bỏ qua bước cọc.
  { from: "quoted", action: "start-purchasing", to: "purchasing" },
  { from: "deposited", action: "start-purchasing", to: "purchasing" },
  { from: "purchasing", action: "mark-purchased", to: "purchased" },
  { from: "purchased", action: "receive-jp", to: "jp_warehouse" },
  { from: "jp_warehouse", action: "start-customs", to: "customs" },
  { from: "customs", action: "complete-tax", to: "tax_done" },
  { from: "tax_done", action: "receive-vn", to: "vn_warehouse" },
  { from: "vn_warehouse", action: "deliver", to: "delivered" },
  { from: "delivered", action: "complete", to: "completed" },
  { from: "completed", action: "close", to: "closed" },
  { from: "quoted", action: "cancel", to: "cancelled" },
  { from: "deposited", action: "cancel", to: "cancelled" },
];

export const isOrderAction = (v: string): v is OrderAction => (ORDER_ACTIONS as readonly string[]).includes(v);

export type AllowedAction = { action: OrderAction; to: OrderStatus; label: string };

// Các bước người dùng được bấm từ trạng thái hiện tại (thứ tự theo bảng; closed/cancelled -> rỗng).
export function allowedActions(status: OrderStatus | null | undefined): AllowedAction[] {
  return USER_TRANSITIONS.filter((t) => t.from === status).map((t) => ({ action: t.action, to: t.to, label: ACTION_LABEL[t.action] }));
}

export const findTransition = (from: OrderStatus, action: OrderAction) =>
  USER_TRANSITIONS.find((t) => t.from === from && t.action === action);

// PATCH /:id/status (tương thích ngược): tìm bước có from=hiện tại, to=yêu cầu.
export const findTransitionTo = (from: OrderStatus, to: OrderStatus) =>
  USER_TRANSITIONS.find((t) => t.from === from && t.to === to);

export function invalidTransition(from: OrderStatus, to: OrderStatus | null, action: string | null): AppError {
  const target = to ?? "?";
  return new AppError("STATE_INVALID_TRANSITION", 409,
    `Không chuyển được trạng thái đơn ${from} -> ${target}${action ? ` (bước "${action}")` : ""}`,
    { from, to, action });
}

export function assertUserTransition(from: OrderStatus, action: OrderAction): Transition {
  const t = findTransition(from, action);
  if (!t) throw invalidTransition(from, null, action);
  return t;
}

// Điểm móc điều kiện nghiệp vụ trước khi chuyển bước (vd. "cọc" có cần phiếu thu không).
// Tài liệu nghiệp vụ CHƯA định nghĩa điều kiện nào -> hiện chỉ kiểm tra trạng thái. Chờ chủ quyết định.
export function checkTransitionPrerequisites(order: Pick<Order, "status">, t: Transition): void {
  if (order.status !== t.from) throw invalidTransition(order.status, t.to, t.action);
}

// ---- Chế độ system (sự kiện kho/sheet) ----

// Các trạng thái được phép chuyển TỰ ĐỘNG sang `target` (mọi trạng thái đứng trước, trừ trạng thái chốt).
export function systemSourcesFor(target: OrderStatus): OrderStatus[] {
  const idx = (STATUS_SEQUENCE as readonly string[]).indexOf(target);
  if (idx === -1) return [];
  return STATUS_SEQUENCE.slice(0, idx).filter((s) => !FROZEN_STATUSES.has(s));
}

export type TransitionMode = "user" | "system" | "correction";

export function canTransition(from: OrderStatus, to: OrderStatus, mode: TransitionMode): boolean {
  if (!(ORDER_STATUSES as readonly string[]).includes(to)) return false;
  if (mode === "correction") return true;
  if (mode === "user") return !!findTransitionTo(from, to);
  return systemSourcesFor(to).includes(from);
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
