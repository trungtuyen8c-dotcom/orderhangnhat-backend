import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

const customerFilter = (customer?: string): Prisma.TrackingWhereInput =>
  customer ? { order: { customer: { name: { contains: customer, mode: "insensitive" } } } } : {};

const BOARD_TRACKING_SELECT = {
  id: true, code: true, cartonId: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, customsName: true,
  order: { select: { code: true, customer: { select: { name: true } } } },
} satisfies Prisma.TrackingSelect;

// Đã "Chuyển lưu kho" thì ra khỏi board chính (xem ở /warehouse/stored), trừ khi đã ship (có Tracking VN) thì luôn loại khỏi board.
// Đơn chỉ order hộ - hàng về kho khác (externalWarehouse) không qua kho VN của mình -> loại luôn khỏi board.
// Đơn chỉ lấy chứng từ, giao thẳng công ty (skipVnWeighing) - vẫn qua kho nhưng không cần cân -> loại khỏi board.
const BOARD_WHERE = {
  status: { not: "stored" },
  OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }],
  NOT: { order: { OR: [{ externalWarehouse: true }, { skipVnWeighing: true }] } },
} satisfies Prisma.TrackingWhereInput;

export function findBoardData(customer?: string) {
  const trkWhere = { ...BOARD_WHERE, ...customerFilter(customer) };
  return Promise.all([
    prisma.carton.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        trackings: { where: trkWhere, select: BOARD_TRACKING_SELECT, orderBy: [{ packedAt: "asc" }, { packRow: "asc" }] },
        // Tổng tracking TỪNG gán vào kiện (mọi trạng thái) - phân biệt kiện mới tạo chưa gán gì (vẫn hiện để gán)
        // với kiện đã dồn hết tracking sang Lưu kho (ẩn khỏi board, xem lại ở "Lưu kho"/"Tra cứu Kho VN").
        _count: { select: { trackings: true } },
      },
    }),
    prisma.tracking.findMany({ where: { packedAt: { not: null }, cartonId: null, ...trkWhere }, select: BOARD_TRACKING_SELECT, orderBy: [{ packedAt: "desc" }, { packRow: "asc" }] }),
  ]);
}

export type BoardData = Awaited<ReturnType<typeof findBoardData>>;

export function findStored(customer?: string) {
  return prisma.tracking.findMany({
    where: { status: "stored", OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], ...customerFilter(customer) },
    orderBy: { storedAt: "asc" }, take: 500,
    select: {
      id: true, code: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, storedAt: true,
      carton: { select: { code: true } }, order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
}

export function findHistory(q: { date?: string; vnTrackingCode?: string; code?: string }) {
  const where: Prisma.TrackingWhereInput = { packedAt: { not: null } };
  if (q.date) { const d = new Date(q.date); where.packedAt = { gte: d, lt: new Date(d.getTime() + 86400000) }; }
  if (q.vnTrackingCode) where.vnTrackingCode = { contains: q.vnTrackingCode, mode: "insensitive" };
  if (q.code) where.code = { contains: q.code, mode: "insensitive" };
  return prisma.tracking.findMany({
    where, orderBy: { packedAt: "desc" }, take: 200,
    select: {
      id: true, code: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, deliveredAt: true,
      storedAt: true, customerReceivedAt: true,
      carton: { select: { code: true } }, order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
}

export function findLateAfterLock() {
  return prisma.tracking.findMany({
    where: { lateAfterLock: true },
    orderBy: { packedAt: "desc" }, take: 200,
    select: { id: true, code: true, packedAt: true, order: { select: { code: true, customer: { select: { name: true } } } } },
  });
}
