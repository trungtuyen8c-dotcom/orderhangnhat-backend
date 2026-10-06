import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

// Khách tra cứu trạng thái đơn (read-only) - select whitelist, KHÔNG lộ giá vốn/ví.
export async function getPublicOrder(token: string) {
  const order = await prisma.order.findUnique({
    where: { publicToken: token },
    select: {
      code: true, status: true, createdAt: true,
      customer: { select: { name: true } },
      items: { select: { name: true, qty: true } },
      trackings: { select: { code: true, status: true } },
    },
  });
  if (!order) throw new AppError("NOT_FOUND", 404);
  return order;
}
