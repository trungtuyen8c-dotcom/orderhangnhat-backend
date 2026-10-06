import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";
import { LegacyError } from "../../app/http/legacyError.js";

export type Actor = { id: string; requestId?: string };

// Kiện hết sạch tracking (do gỡ/xóa tracking khỏi Kho VN) -> tự xóa luôn cho khỏi hiện kiện trống gây rối bảng Kho VN.
// Không dùng cho "Tạo kiện" thủ công (kiện mới tạo chưa gán tracking) vì chỉ gọi hàm này SAU khi 1 tracking rời khỏi kiện.
// Gọi SAU khi transaction commit (lỗi được nuốt - nếu chạy trong tx, query lỗi sẽ làm hỏng cả tx).
export async function deleteCartonIfEmpty(cartonId: string | null | undefined): Promise<void> {
  if (!cartonId) return;
  try {
    const count = await prisma.tracking.count({ where: { cartonId } });
    if (count === 0) await prisma.carton.delete({ where: { id: cartonId } });
  } catch {
    // carton đã bị xóa trước đó (race) hoặc lỗi tạm - bỏ qua, không chặn luồng chính
  }
}

// Kiện khóa cân từng mã lẻ (không khóa Tracking VN/ship) khi: thiếu 1 trong 2 tổng (kho Nhật khai báo / kho VN
// nhập tay), hoặc 2 tổng lệch nhau >= 1kg mà chưa được Sale/NV mua bấm "Xác nhận" (weightConfirmedAt).
export const CARTON_WEIGHT_DIFF_THRESHOLD_KG = 1;
export function cartonWeightLocked(c: { declaredWeightKg: unknown; vnTotalWeightKg: unknown; weightConfirmedAt: Date | null }): boolean {
  const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : null;
  const vnTotal = c.vnTotalWeightKg != null ? Number(c.vnTotalWeightKg) : null;
  if (declared == null || vnTotal == null) return true;
  return Math.abs(declared - vnTotal) >= CARTON_WEIGHT_DIFF_THRESHOLD_KG && !c.weightConfirmedAt;
}

// Tạo kiện thủ công (cùng dữ liệu như POST /control/cartons) - module control có thể chuyển sang gọi hàm này.
export async function createCarton(
  input: { code: string; declaredWeightKg?: number | null; electronicsCount?: number | null; packedDate?: string | null; note?: string | null },
  actor: Actor,
) {
  const c = await prisma.carton.create({
    data: {
      id: uuid(), code: input.code, declaredWeightKg: input.declaredWeightKg ?? null, electronicsCount: input.electronicsCount ?? null,
      packedDate: input.packedDate ? new Date(input.packedDate) : null, note: input.note ?? null,
    },
  });
  await logAudit({ actorId: actor.id, targetId: c.id, action: "carton.created", requestId: actor.requestId });
  eventBus.publish({ eventName: "carton.created", actorId: actor.id, entityType: "carton", entityId: c.id, metadata: { code: c.code } });
  return c;
}

// Tổng cân VN (Kho VN tự cân, nhập tay) - phải điền trước khi mở khóa cân từng mã lẻ trong kiện. Sửa lại thì
// reset xác nhận lệch cân cũ (nếu có), vì số vừa đổi chưa chắc còn khớp với lần xác nhận trước.
export async function setVnTotalWeight(id: string, vnTotalWeightKg: number | null, actor: Actor) {
  const c = await prisma.carton.update({ where: { id }, data: { vnTotalWeightKg, weightConfirmedAt: null } });
  if (cartonWeightLocked(c)) {
    eventBus.publish({ eventName: "carton.locked", actorId: actor.id, entityType: "carton", entityId: c.id, metadata: { vnTotalWeightKg } });
  }
  return c;
}

// Sale/NV mua xác nhận đã hỏi lại kho Nhật, chấp nhận mức lệch cân hiện tại - mở khóa cân từng mã lẻ.
export async function confirmWeight(id: string, actor: Actor) {
  const carton = await prisma.carton.findUnique({ where: { id }, select: { declaredWeightKg: true, vnTotalWeightKg: true } });
  if (!carton) throw new LegacyError(404, "NOT_FOUND");
  if (carton.declaredWeightKg == null || carton.vnTotalWeightKg == null) {
    throw new LegacyError(400, "MISSING_TOTALS", "Cần đủ cân tổng kho Nhật và tổng cân VN trước khi xác nhận");
  }
  const c = await prisma.carton.update({ where: { id }, data: { weightConfirmedAt: new Date() } });
  const metadata = { declaredWeightKg: String(carton.declaredWeightKg), vnTotalWeightKg: String(carton.vnTotalWeightKg) };
  await logAudit({ actorId: actor.id, targetId: c.id, action: "carton.weight_confirmed", metadata, requestId: actor.requestId });
  eventBus.publish({ eventName: "warehouse.weight_confirmed", actorId: actor.id, entityType: "carton", entityId: c.id, metadata });
  return c;
}

// Số thiết bị điện tử (Kho VN tự đếm/kiểm tra lại khi nhận kiện) - sửa lại số thì reset xác nhận cũ.
export function setElectronicsCount(id: string, electronicsCount: number | null) {
  return prisma.carton.update({ where: { id }, data: { electronicsCount, electronicsConfirmedAt: null } });
}

// Kho VN xác nhận đã đếm thực tế khớp đúng electronicsCount đã điền.
export async function confirmElectronics(id: string, actor: Actor) {
  const carton = await prisma.carton.findUnique({ where: { id }, select: { electronicsCount: true } });
  if (!carton) throw new LegacyError(404, "NOT_FOUND");
  if (carton.electronicsCount == null) throw new LegacyError(400, "MISSING_COUNT", "Cần điền số thiết bị trước khi xác nhận");
  const c = await prisma.carton.update({ where: { id }, data: { electronicsConfirmedAt: new Date() } });
  await logAudit({ actorId: actor.id, targetId: c.id, action: "carton.electronics_confirmed", metadata: { electronicsCount: String(carton.electronicsCount) }, requestId: actor.requestId });
  return c;
}
