import { prisma } from "../../infrastructure/prisma.js";

// Truy vấn chỉ đọc cho kênh /api/ext (MCP). Response rút gọn, không lộ field nội bộ.

export const clampLimit = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

export async function listOrders(q: { limit: number; status?: string; source?: string; dateFrom?: string; dateTo?: string }) {
  const { status, source, dateFrom, dateTo } = q;
  const orders = await prisma.order.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(source ? { source } : {}),
      ...(dateFrom || dateTo ? { orderDate: { ...(dateFrom ? { gte: new Date(dateFrom) } : {}), ...(dateTo ? { lte: new Date(`${dateTo}T23:59:59`) } : {}) } } : {}),
    },
    orderBy: { orderDate: "desc" },
    take: q.limit,
    select: {
      code: true, status: true, source: true, orderDate: true, createdAt: true,
      totalQuote: true, totalVnd: true, dueJpy: true, deposit: true,
      customer: { select: { name: true } },
      _count: { select: { trackings: true } },
    },
  });
  return {
    total_matched: orders.length, returned: orders.length,
    orders: orders.map((o) => ({
      code: o.code, status: o.status, source: o.source, customer: o.customer.name,
      orderDate: o.orderDate, totalVnd: o.totalVnd, dueJpy: o.dueJpy, deposit: o.deposit, trackingCount: o._count.trackings,
    })),
  };
}

export function getOrder(code: string) {
  return prisma.order.findUnique({
    where: { code },
    select: {
      code: true, status: true, source: true, orderDate: true, totalQuote: true, totalVnd: true, dueJpy: true, deposit: true,
      couponAmount: true, couponCurrency: true, commissionPercent: true,
      customer: { select: { name: true, phone: true, payCurrency: true } },
      trackings: { select: { code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, deliveredAt: true } },
    },
  });
}

export async function listCustomers(q: { limit: number; q: string }) {
  const customers = await prisma.customer.findMany({
    where: q.q ? { OR: [{ name: { contains: q.q, mode: "insensitive" } }, { code: { contains: q.q, mode: "insensitive" } }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: q.limit,
    select: { code: true, name: true, phone: true, _count: { select: { orders: true } } },
  });
  return { total_matched: customers.length, returned: customers.length, customers: customers.map((c) => ({ code: c.code, name: c.name, phone: c.phone, orderCount: c._count.orders })) };
}

export async function listTrackings(q: { limit: number; customer?: string; stock?: string }) {
  const trackings = await prisma.tracking.findMany({
    where: {
      ...(q.customer ? { order: { customer: { name: { contains: q.customer, mode: "insensitive" } } } } : {}),
      ...(q.stock === "true" ? { packedAt: { not: null }, deliveredAt: null } : {}),
    },
    orderBy: { packedAt: "desc" },
    take: q.limit,
    select: {
      code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, deliveredAt: true,
      order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
  return {
    total_matched: trackings.length, returned: trackings.length,
    trackings: trackings.map((t) => ({
      code: t.code, vnTrackingCode: t.vnTrackingCode, jpWeightKg: t.jpWeightKg, vnWeightKg: t.vnWeightKg,
      packedAt: t.packedAt, deliveredAt: t.deliveredAt, orderCode: t.order?.code ?? null, customer: t.order?.customer.name ?? null,
    })),
  };
}
