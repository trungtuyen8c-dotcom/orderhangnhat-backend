import { v4 as uuid } from "uuid";
import { prisma } from "../db.js";

// Mã có thể đã bị kho quét trước đó (tạo mồ côi chờ gắn đơn) -> claim lại đúng dòng đó thay vì tạo trùng
// (giữ nguyên cân/kiện/ngày đóng đã có), tránh 1 mã tồn tại nhiều Tracking rác trong DB (đếm "dùng chung N đơn"
// trên sheet kho bị sai, giá/tên gộp nhầm). Mã đã gắn sẵn cho đơn KHÁC (orderId khác null) thì vẫn tạo mới bình
// thường - đó là case hợp lệ (shop gộp nhiều đơn chung 1 tracking), không phải bug.
export async function claimOrCreateTracking(orderId: string, code: string, extra: Record<string, unknown> = {}) {
  const trimmed = code.trim();
  if (trimmed) {
    const orphan = await prisma.tracking.findFirst({ where: { code: trimmed, orderId: null } });
    if (orphan) return prisma.tracking.update({ where: { id: orphan.id }, data: { orderId, status: "linked", ...extra } });
  }
  return prisma.tracking.create({ data: { id: uuid(), orderId, code: trimmed, status: "linked", ...extra } });
}
