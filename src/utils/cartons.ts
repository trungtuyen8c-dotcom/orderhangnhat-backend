import { prisma } from "../db.js";

// Kiện hết sạch tracking (do gỡ/xóa tracking khỏi Kho VN) -> tự xóa luôn cho khỏi hiện kiện trống gây rối bảng Kho VN.
// Không dùng cho "Tạo kiện" thủ công (kiện mới tạo chưa gán tracking) vì chỉ gọi hàm này SAU khi 1 tracking rời khỏi kiện.
export async function deleteCartonIfEmpty(cartonId: string | null | undefined): Promise<void> {
  if (!cartonId) return;
  try {
    const count = await prisma.tracking.count({ where: { cartonId } });
    if (count === 0) await prisma.carton.delete({ where: { id: cartonId } });
  } catch {
    // carton đã bị xóa trước đó (race) hoặc lỗi tạm - bỏ qua, không chặn luồng chính
  }
}
