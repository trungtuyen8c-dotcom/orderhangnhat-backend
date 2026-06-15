import { Router } from "express";
import { prisma } from "../../db.js";

export const publicRouter = Router();

// Khách tra cứu trạng thái đơn (read-only, KHÔNG lộ giá vốn/ví)
publicRouter.get("/orders/:token", async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { publicToken: req.params.token },
    select: {
      code: true, status: true, createdAt: true,
      customer: { select: { name: true } },
      items: { select: { name: true, qty: true } },
      trackings: { select: { code: true, status: true } },
    },
  });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(order);
});
