import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

export type Db = Prisma.TransactionClient | typeof prisma;

type HistoryTracking = { id: string; code: string; order: { id: string; code: string; customer: { name: string } | null } | null };

// Ghi 1 lần xuất invoice + snapshot từng tracking (gọi TRONG transaction của buildInvoice).
export async function createInvoiceHistory(
  db: Db,
  d: { createdBy: string | null; note: string | null; totalJpy: number; lineCount: number; trackings: HistoryTracking[] },
): Promise<string> {
  const inv = await db.invoice.create({
    data: { createdBy: d.createdBy, note: d.note, totalJpy: d.totalJpy, lineCount: d.lineCount, trackingCount: d.trackings.length },
    select: { id: true },
  });
  await db.invoiceItem.createMany({
    data: d.trackings.map((t) => ({
      invoiceId: inv.id, trackingId: t.id, trackingCode: t.code,
      orderId: t.order?.id ?? null, orderCode: t.order?.code ?? null, customerName: t.order?.customer?.name ?? null,
    })),
  });
  return inv.id;
}

export type PendingQuery = { start: Date; end: Date; q?: string; unpacked?: boolean };

// Món đã mua (đơn có món, chưa hủy/nháp, không phải đơn order hộ về kho khác) theo tháng đặt (orderDate, giờ VN)
// mà tracking CHƯA TỪNG nằm trong 1 lần xuất invoice nào.
export function pendingWhere(p: PendingQuery): Prisma.TrackingWhereInput {
  const where: Prisma.TrackingWhereInput = {
    invoiceItems: { none: {} },
    order: {
      orderDate: { gte: p.start, lt: p.end },
      status: { notIn: ["cancelled", "draft"] },
      externalWarehouse: false,
      items: { some: {} },
    },
  };
  if (p.unpacked) where.packedAt = null;
  if (p.q) {
    const c = { contains: p.q, mode: "insensitive" as const };
    where.AND = [{ OR: [{ code: c }, { order: { code: c } }, { order: { customer: { name: c } } }] }];
  }
  return where;
}

export const PENDING_SELECT = {
  id: true, code: true, status: true, packedAt: true, jpName: true, createdAt: true,
  order: {
    select: {
      id: true, code: true, orderDate: true, status: true,
      customer: { select: { name: true } },
      items: { select: { name: true, qty: true, unitPriceJpy: true }, orderBy: { name: "asc" } },
    },
  },
} satisfies Prisma.TrackingSelect;

export function listPending(where: Prisma.TrackingWhereInput, page: { skip: number; take: number }) {
  return prisma.tracking.findMany({
    where, select: PENDING_SELECT, skip: page.skip, take: page.take,
    orderBy: [{ order: { orderDate: "asc" } }, { order: { code: "asc" } }, { createdAt: "asc" }, { id: "asc" }],
  });
}

export function pendingKeys(where: Prisma.TrackingWhereInput) {
  return prisma.tracking.findMany({ where, select: { orderId: true, packedAt: true } });
}

export function orderItemsOf(orderIds: string[]) {
  return prisma.orderItem.findMany({ where: { orderId: { in: orderIds } }, select: { qty: true, unitPriceJpy: true } });
}

export function listInvoices(page: { skip: number; take: number }) {
  return prisma.invoice.findMany({ orderBy: { createdAt: "desc" }, skip: page.skip, take: page.take });
}

export function countInvoices() {
  return prisma.invoice.count();
}

export function findInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: { items: { orderBy: [{ orderCode: "asc" }, { trackingCode: "asc" }], include: { tracking: { select: { code: true } } } } },
  });
}

export function userNames(ids: string[]) {
  return prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } });
}
