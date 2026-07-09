import { v4 as uuid } from "uuid";
import { prisma } from "../db.js";

// Tiền ship 1 tracking = cân (kg) x đơn giá/kg (quy về VND).
// Ưu tiên cân VN (thực tế); chưa cân VN thì tạm dùng cân JP (báo trước).
// Đơn giá có thể theo VND/kg hoặc JPY/kg (shipRateCurrency); JPY thì nhân tỉ giá.
export function trackingShipVnd(t: { jpWeightKg: unknown; vnWeightKg?: unknown; unitPriceVndPerKg: unknown; shipRateCurrency?: unknown }, rate = 0): number {
  const kg = t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);
  const price = Number(t.unitPriceVndPerKg ?? 0);
  const perKgVnd = t.shipRateCurrency === "JPY" ? price * rate : price;
  return kg * perKgVnd;
}

// Số dư nợ 1 đơn. Có tỉ giá -> nợ theo VND (paid = tổng amountVnd các phiếu thu/chi).
// Chưa có tỉ giá (khách trả thẳng ¥) -> KHÔNG ép subtotal ¥ thành số ₫ (sai đơn vị), giữ nợ theo ¥
// và chỉ trừ phần đã thu bằng ¥ (payments currency=JPY dùng amountOrig).
export function computeDebtBalance(
  order: { totalVnd: unknown; totalQuote: unknown },
  payments: { type: string; amountVnd: unknown; currency: string; amountOrig: unknown }[],
): { balance: number; currency: "VND" | "JPY" } {
  if (order.totalVnd != null) {
    const paidVnd = payments.reduce((s, p) => (p.type === "refund" ? s - Number(p.amountVnd) : s + Number(p.amountVnd)), 0);
    return { balance: Number(order.totalVnd) - paidVnd, currency: "VND" };
  }
  const paidJpy = payments.reduce((s, p) => {
    if (p.currency !== "JPY") return s;
    return p.type === "refund" ? s - Number(p.amountOrig) : s + Number(p.amountOrig);
  }, 0);
  return { balance: Number(order.totalQuote ?? 0) - paidJpy, currency: "JPY" };
}

// Tính lại totalQuote (¥), totalVnd và công nợ của 1 đơn.
// totalVnd = subtotal¥ x tỉ giá + ship + phụ thu - giảm (¥ x tỉ giá, ₫ cộng thẳng) + ship các tracking gán đơn.
// Chưa có tỉ giá mà còn khoản ¥ chưa quy đổi -> totalVnd = null.
export async function recomputeOrderTotals(orderId: string): Promise<{ totalQuote: number; totalVnd: number | null } | undefined> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, trackings: true, payments: true, customer: { select: { shipRatePerKg: true } } },
  });
  if (!order) return;

  const subtotalJpy = order.items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy) + Number(i.shipJpy ?? 0), 0);
  const rate = Number(order.exchangeRate ?? 0);
  const toVnd = (amt: number, cur: string) => (cur === "JPY" ? amt * rate : amt);
  // Đơn giá ship/kg: ưu tiên đặt trên tracking, không có thì lấy mặc định của khách (kho không cần nhập)
  const custRate = order.customer?.shipRatePerKg != null ? Number(order.customer.shipRatePerKg) : null;
  const trackingShip = order.trackings.reduce((s, t) => s + trackingShipVnd({ ...t, unitPriceVndPerKg: t.unitPriceVndPerKg ?? custRate }, rate), 0);

  // 着払い/COD do kho Nhật báo theo từng mã tracking (nhập ở "Phải trả kho/cty") -> cộng thẳng vào công nợ khách
  // của đúng đơn gắn mã đó. Lấy sống từ CompanyCost (không cache) -> xóa khoản là tự trừ lại ngay lần recompute sau.
  const codRows = order.trackings.length
    ? await prisma.companyCost.groupBy({
        by: ["refId"],
        where: { kind: "chakubarai", refId: { in: order.trackings.map((t) => t.id) } },
        _sum: { amountVnd: true },
      })
    : [];
  const codVnd = codRows.reduce((s, r) => s + Number(r._sum.amountVnd ?? 0), 0);

  const jpyFee = (amt: unknown, cur: string) => cur === "JPY" && Number(amt) > 0;
  const trackingNeedsRate = order.trackings.some((t) => t.shipRateCurrency === "JPY" && Number(t.unitPriceVndPerKg ?? 0) > 0);
  const hasUnconverted =
    (subtotalJpy > 0
      || trackingNeedsRate
      || jpyFee(order.shipAmount, order.shipCurrency)
      || jpyFee(order.surchargeAmount, order.surchargeCurrency)
      || jpyFee(order.discountAmount, order.discountCurrency)
      || jpyFee(order.serviceFeeAmount, order.serviceFeeCurrency)
      || jpyFee(order.jpDomesticShipAmount, order.jpDomesticShipCurrency)
      || jpyFee(order.intlShipAmount, order.intlShipCurrency))
    && !rate;

  const totalVnd = hasUnconverted
    ? null
    : subtotalJpy * rate
      + toVnd(Number(order.shipAmount), order.shipCurrency)
      + toVnd(Number(order.surchargeAmount), order.surchargeCurrency)
      + toVnd(Number(order.serviceFeeAmount), order.serviceFeeCurrency)
      + toVnd(Number(order.jpDomesticShipAmount), order.jpDomesticShipCurrency)
      + toVnd(Number(order.intlShipAmount), order.intlShipCurrency)
      - toVnd(Number(order.discountAmount), order.discountCurrency)
      + trackingShip
      + codVnd;

  await prisma.order.update({ where: { id: orderId }, data: { totalQuote: subtotalJpy, totalVnd } });

  // Công nợ chỉ cập nhật khi đã có (giữ nguyên: công nợ phát sinh khi ghi tiền)
  const existing = await prisma.debt.findFirst({ where: { orderId } });
  if (existing) {
    const { balance, currency } = computeDebtBalance({ totalVnd, totalQuote: subtotalJpy }, order.payments);
    await prisma.debt.update({ where: { id: existing.id }, data: { balance, currency } });
  }

  return { totalQuote: subtotalJpy, totalVnd };
}
