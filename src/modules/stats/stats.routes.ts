import { Router } from "express";
import { prisma } from "../../db.js";
import { redis } from "../../redis.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";

export const statsRouter = Router();
statsRouter.use(authenticateEither);

statsRouter.get("/alerts", authorize("stats.view"), async (_req, res) => {
  const raw = await redis.get("alerts:late_orders");
  res.json(raw ? JSON.parse(raw) : { count: 0, orders: [] });
});

// "Hoàn tất" thực tế không dựa vào Order.status (trường này ít khi được cập nhật tay) mà suy ra từ dữ liệu thật:
// - Khách không cân ở Kho VN (externalWarehouse/skipVnWeighing): xong khi đã đủ giá, có tracking Nhật, đã đóng
//   hàng (packedAt) và đã lấy thuế xong (mọi tracking needsTax=true đều taxCollected=true).
// - Khách có cân: thêm điều kiện đủ cân Nhật/VN từng mã. KHÔNG bắt buộc có Tracking VN - nhiều đơn giao tay/lấy
//   trực tiếp không đi qua ship nội địa nên không bao giờ có mã này dù đơn đã xong thật sự.
export function isOrderComplete(o: {
  externalWarehouse: boolean; skipVnWeighing: boolean;
  items: { unitPriceJpy: unknown }[];
  trackings: { packedAt: Date | null; needsTax: boolean; taxCollected: boolean; jpWeightKg: unknown; vnWeightKg: unknown }[];
}): boolean {
  if (!o.trackings.length) return false;
  if (o.items.some((i) => Number(i.unitPriceJpy) === 0)) return false;
  if (o.trackings.some((t) => !t.packedAt)) return false;
  if (o.trackings.some((t) => t.needsTax && !t.taxCollected)) return false;
  if (!o.externalWarehouse && !o.skipVnWeighing) {
    if (o.trackings.some((t) => t.jpWeightKg == null || t.vnWeightKg == null)) return false;
  }
  return true;
}

statsRouter.get("/", authorize("stats.view"), async (_req, res) => {
  const [byStatus, customers, totalOrders, cancelledOrders, liveOrders] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.customer.count(),
    prisma.order.count(),
    prisma.order.count({ where: { status: "cancelled" } }),
    prisma.order.findMany({
      where: { status: { not: "cancelled" } },
      select: {
        externalWarehouse: true, skipVnWeighing: true,
        items: { select: { unitPriceJpy: true } },
        trackings: { select: { packedAt: true, needsTax: true, taxCollected: true, jpWeightKg: true, vnWeightKg: true } },
      },
    }),
  ]);
  const completedOrders = liveOrders.filter(isOrderComplete).length;
  const inProgressOrders = liveOrders.length - completedOrders;
  res.json({
    totalOrders,
    customers,
    completedOrders,
    inProgressOrders,
    cancelledOrders,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
  });
});
