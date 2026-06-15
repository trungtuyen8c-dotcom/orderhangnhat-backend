import { Router } from "express";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";

export const statsRouter = Router();
statsRouter.use(authenticate);

statsRouter.get("/", async (_req, res) => {
  const [byStatus, customers, totalOrders] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.customer.count(),
    prisma.order.count(),
  ]);
  res.json({
    totalOrders,
    customers,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
  });
});
