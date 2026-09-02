import { prisma } from "../db.js";

// Đúng thứ tự tiến trình vật lý của 1 đơn (đồng bộ enum OrderStatus trong schema.prisma).
const STATUS_SEQUENCE = [
  "draft", "quoted", "deposited", "purchasing", "purchased", "jp_warehouse",
  "customs", "tax_done", "vn_warehouse", "delivered", "completed", "closed",
] as const;
type SequencedStatus = (typeof STATUS_SEQUENCE)[number];
// Trạng thái do người dùng tự chốt tay - sự kiện kho tự động không được ghi đè lên các trạng thái này.
const FROZEN = new Set(["completed", "closed", "cancelled"]);

// Tự tiến Order.status theo đúng sự kiện vật lý ở Kho Nhật/Kho VN (đóng gói -> về kho VN -> ship),
// chỉ tiến tới, không lùi lại, không đụng đơn đã ở trạng thái chốt tay (completed/closed/cancelled).
export async function bumpOrderStatus(orderIds: string | string[], target: SequencedStatus): Promise<void> {
  const ids = (Array.isArray(orderIds) ? orderIds : [orderIds]).filter(Boolean);
  if (!ids.length) return;
  const targetIdx = STATUS_SEQUENCE.indexOf(target);
  if (targetIdx === -1) return;
  const allowedFrom = STATUS_SEQUENCE.slice(0, targetIdx).filter((s) => !FROZEN.has(s));
  await prisma.order.updateMany({ where: { id: { in: ids }, status: { in: allowedFrom as any } }, data: { status: target as any } });
}
