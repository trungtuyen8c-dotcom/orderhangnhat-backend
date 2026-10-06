import { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

// Tạo tracking mồ côi (orderId null) an toàn khi 2 nguồn (cron 2 phút + webhook tức thì) cùng đụng 1 mã cùng
// lúc - unique index trackings_code_orphan_uniq (tạo trong migration 1_orphan_tracking_unique_index) chặn trùng ở tầng DB, gặp lỗi trùng
// thì lấy lại đúng dòng đã có thay vì crash cả loạt quét.
export async function createOrphanTrackingSafe(data: Parameters<typeof prisma.tracking.create>[0]["data"]) {
  try {
    return await prisma.tracking.create({ data });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.tracking.findFirst({ where: { code: data.code as string, orderId: null } });
      if (existing) return existing;
    }
    throw e;
  }
}
