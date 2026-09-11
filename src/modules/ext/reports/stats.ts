// Report stats_* - stats_overview đã có trực tiếp trong ext.routes.ts, đây là stats_alerts (đọc Redis cache).
import { prisma } from "../../../db.js";
import { redis } from "../../../redis.js";

export async function stats_overview() {
  const [byStatus, customers, totalOrders] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.customer.count(),
    prisma.order.count(),
  ]);
  return { totalOrders, customers, byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })) };
}

export async function stats_alerts() {
  const raw = await redis.get("alerts:late_orders");
  return raw ? JSON.parse(raw) : { count: 0, orders: [] };
}
