import { v4 as uuid } from "uuid";
import { prisma } from "../db.js";

// Tiền ship 1 tracking tính cho khách = cân (kg) x đơn giá (đ/kg)
export function trackingShipVnd(t: { jpWeightKg: unknown; unitPriceVndPerKg: unknown }): number {
  return Number(t.jpWeightKg ?? 0) * Number(t.unitPriceVndPerKg ?? 0);
}

// Tính lại totalQuote (¥), totalVnd và công nợ của 1 đơn.
// totalVnd = subtotal¥ x tỉ giá + ship + phụ thu - giảm (¥ x tỉ giá, ₫ cộng thẳng) + ship các tracking gán đơn.
// Chưa có tỉ giá mà còn khoản ¥ chưa quy đổi -> totalVnd = null.
export async function recomputeOrderTotals(orderId: string): Promise<{ totalQuote: number; totalVnd: number | null } | undefined> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, trackings: true, payments: true },
  });
  if (!order) return;

  const subtotalJpy = order.items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
  const rate = Number(order.exchangeRate ?? 0);
  const toVnd = (amt: number, cur: string) => (cur === "JPY" ? amt * rate : amt);
  const trackingShip = order.trackings.reduce((s, t) => s + trackingShipVnd(t), 0);

  const hasUnconverted =
    (subtotalJpy > 0
      || (order.shipCurrency === "JPY" && Number(order.shipAmount) > 0)
      || (order.surchargeCurrency === "JPY" && Number(order.surchargeAmount) > 0)
      || (order.discountCurrency === "JPY" && Number(order.discountAmount) > 0))
    && !rate;

  const totalVnd = hasUnconverted
    ? null
    : subtotalJpy * rate
      + toVnd(Number(order.shipAmount), order.shipCurrency)
      + toVnd(Number(order.surchargeAmount), order.surchargeCurrency)
      - toVnd(Number(order.discountAmount), order.discountCurrency)
      + trackingShip;

  await prisma.order.update({ where: { id: orderId }, data: { totalQuote: subtotalJpy, totalVnd } });

  // Công nợ chỉ cập nhật khi đã có (giữ nguyên: công nợ phát sinh khi ghi tiền)
  const existing = await prisma.debt.findFirst({ where: { orderId } });
  if (existing) {
    const paid = order.payments.reduce((s, p) => (p.type === "refund" ? s - Number(p.amountVnd) : s + Number(p.amountVnd)), 0);
    const balance = Number(totalVnd ?? subtotalJpy) - paid;
    await prisma.debt.update({ where: { id: existing.id }, data: { balance } });
  }

  return { totalQuote: subtotalJpy, totalVnd };
}
