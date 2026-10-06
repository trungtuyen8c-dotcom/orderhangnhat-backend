import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

export type Db = Prisma.TransactionClient | typeof prisma;

// Mã có thể đã bị kho quét trước đó (tạo mồ côi chờ gắn đơn) -> claim lại đúng dòng đó thay vì tạo trùng
// (giữ nguyên cân/kiện/ngày đóng đã có), tránh 1 mã tồn tại nhiều Tracking rác trong DB (đếm "dùng chung N đơn"
// trên sheet kho bị sai, giá/tên gộp nhầm). Mã đã gắn sẵn cho đơn KHÁC (orderId khác null) thì vẫn tạo mới bình
// thường - đó là case hợp lệ (shop gộp nhiều đơn chung 1 tracking), không phải bug.
export async function claimOrCreateTracking(orderId: string, code: string, extra: Record<string, unknown> = {}, db: Db = prisma) {
  const trimmed = code.trim();
  if (trimmed) {
    const orphan = await db.tracking.findFirst({ where: { code: trimmed, orderId: null } });
    if (orphan) return db.tracking.update({ where: { id: orphan.id }, data: { orderId, status: "linked", ...extra } });
  }
  return db.tracking.create({ data: { id: uuid(), orderId, code: trimmed, status: "linked", ...extra } });
}

export const TRACKING_LIST_INCLUDE = {
  carton: { select: { code: true } },
  order: { select: { code: true, needsCheck: true, checkNote: true, exchangeRate: true, customer: { select: { name: true } }, items: { select: { url: true } } } },
} satisfies Prisma.TrackingInclude;

export function trackingListWhere(q: { orderId?: string; stock?: boolean; customer?: string }): Prisma.TrackingWhereInput {
  const where: Prisma.TrackingWhereInput = {};
  if (q.orderId) where.orderId = q.orderId;
  // Tồn kho = đã về kho (packedAt) nhưng chưa có tracking VN (chưa đóng đi VN)
  if (q.stock) { where.packedAt = { not: null }; where.OR = [{ vnTrackingCode: null }, { vnTrackingCode: "" }]; }
  if (q.customer) where.order = { customer: { name: { contains: q.customer, mode: "insensitive" } } };
  return where;
}

export function listTrackings(where: Prisma.TrackingWhereInput, page: { skip: number; take: number }) {
  return prisma.tracking.findMany({ where, orderBy: { createdAt: "desc" }, skip: page.skip, take: page.take, include: TRACKING_LIST_INCLUDE });
}

export function countTrackings(where: Prisma.TrackingWhereInput) {
  return prisma.tracking.count({ where });
}

export function findTrackingsForInvoice(ids: string[]) {
  return prisma.tracking.findMany({ where: { id: { in: ids } }, include: { order: { include: { items: true, customer: true } } } });
}

export async function customerIdOfOrder(orderId: string): Promise<string | null> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { customerId: true } });
  return o?.customerId ?? null;
}

// CompanyCost.refId -> Tracking (onDelete: Restrict): tracking có khoản chakubarai thì không xóa được.
export function countCompanyCostsOfTracking(trackingId: string) {
  return prisma.companyCost.count({ where: { refId: trackingId } });
}
