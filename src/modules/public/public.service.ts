import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

// Khách tra cứu trạng thái đơn (read-only) - select whitelist, KHÔNG lộ giá vốn/ví.
// REST + SSE (public.events.ts) dùng chung select này để payload 2 đường luôn giống hệt nhau.
export const PUBLIC_ORDER_SELECT = {
  code: true, status: true, createdAt: true,
  customer: { select: { name: true } },
  items: { select: { name: true, qty: true } },
  trackings: { select: { code: true, status: true } },
} as const;

export async function getPublicOrder(token: string) {
  const order = await prisma.order.findUnique({ where: { publicToken: token }, select: PUBLIC_ORDER_SELECT });
  if (!order) throw new AppError("NOT_FOUND", 404);
  return order;
}

export async function findOrderIdByToken(token: string): Promise<string | null> {
  const o = await prisma.order.findUnique({ where: { publicToken: token }, select: { id: true } });
  return o?.id ?? null;
}

export function getPublicOrderById(orderId: string) {
  return prisma.order.findUnique({ where: { id: orderId }, select: PUBLIC_ORDER_SELECT });
}

export async function orderIdOfTracking(trackingId: string): Promise<string | null> {
  const t = await prisma.tracking.findUnique({ where: { id: trackingId }, select: { orderId: true } });
  return t?.orderId ?? null;
}
