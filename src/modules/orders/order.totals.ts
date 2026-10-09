import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

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

// Đơn giá cân/kg mặc định của khách theo tuyến kiện: biển dùng giá biển (chưa đặt thì lấy giá bay).
export function customerShipRate(
  customer: { shipRatePerKg?: unknown; shipRateSeaPerKg?: unknown } | null | undefined,
  route: string | null | undefined,
): number | null {
  if (!customer) return null;
  if (route === "sea" && customer.shipRateSeaPerKg != null) return Number(customer.shipRateSeaPerKg);
  return customer.shipRatePerKg != null ? Number(customer.shipRatePerKg) : null;
}

type CodEntry = { currency: string; amountOrig: unknown; amountVnd: unknown; exchangeRate: unknown };
type PricedOrder = {
  items: { qty: number; unitPriceJpy: unknown; shipJpy?: unknown }[];
  exchangeRate?: unknown; commissionPercent?: unknown;
  shipAmount: unknown; shipCurrency: string; surchargeAmount: unknown; surchargeCurrency: string;
  discountAmount: unknown; discountCurrency: string; serviceFeeAmount: unknown; serviceFeeCurrency: string;
  serviceFeeCustomerPays?: boolean | null;
  jpDomesticShipAmount: unknown; jpDomesticShipCurrency: string; intlShipAmount: unknown; intlShipCurrency: string;
};

// Khoản khách phải trả của 1 đơn, tách ¥ / ₫ (KHÔNG gồm kupon - kupon chỉ giảm tiền thẻ, khách vẫn trả đủ).
// Giống sheet đặt hàng: Tổng = giá + ship món - giảm giá khách (¥); Công = Tổng x %; Tiền KH = (Tổng + Công) x tỉ giá.
// jpy = phần định giá ¥ (hàng + ship món - giảm ¥ + công + phí ¥ + COD ¥ chưa quy đổi); vnd = phần ₫ (phí ₫ - giảm ₫ + COD ₫).
export function orderCharges(o: PricedOrder, cods: CodEntry[] = []) {
  const itemsJpy = o.items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy) + Number(i.shipJpy ?? 0), 0);
  let jpy = 0, vnd = 0;
  const add = (amt: unknown, cur: string, sign = 1) => { const v = Number(amt ?? 0) * sign; if (cur === "JPY") jpy += v; else vnd += v; };
  const discountJpy = o.discountCurrency === "JPY" ? Number(o.discountAmount ?? 0) : 0;
  const commissionJpy = (itemsJpy - discountJpy) * (Number(o.commissionPercent ?? 0) / 100);
  jpy += itemsJpy - discountJpy + commissionJpy;
  if (o.discountCurrency !== "JPY") vnd -= Number(o.discountAmount ?? 0);
  add(o.shipAmount, o.shipCurrency);
  add(o.surchargeAmount, o.surchargeCurrency);
  if (o.serviceFeeCustomerPays !== false) add(o.serviceFeeAmount, o.serviceFeeCurrency);
  add(o.jpDomesticShipAmount, o.jpDomesticShipCurrency);
  add(o.intlShipAmount, o.intlShipCurrency);
  let codJpy = 0, codVnd = 0;
  for (const c of cods) {
    // COD ¥ nhập kèm tỉ giá -> đã có số ₫ chốt sẵn; không kèm tỉ giá -> giữ ¥ (khách yên trả ¥, khách ₫ quy theo tỉ giá đơn).
    if (c.currency === "JPY") { codJpy += Number(c.amountOrig ?? 0); if (c.exchangeRate != null) codVnd += Number(c.amountVnd ?? 0); }
    else codVnd += Number(c.amountVnd ?? 0);
  }
  return { itemsJpy, commissionJpy, jpy, vnd, codJpy, codVndFixed: codVnd };
}

// Tính lại totalQuote (¥), totalVnd, dueJpy và công nợ của 1 đơn.
// Khách ₫: totalVnd = phần ¥ x tỉ giá + phần ₫ + ship các tracking (+ COD). Chưa có tỉ giá mà còn khoản ¥ -> null.
// Khách ¥: dueJpy = phần ¥ (gồm COD ¥), totalVnd = phần ₫ (ship tracking + phí ₫) - không cần tỉ giá.
// Truyền `tx` khi đang ở trong 1 transaction; không truyền thì tự mở transaction riêng (totals + công nợ ghi cùng lúc).
export type Totals = { totalQuote: number; totalVnd: number | null; dueJpy: number | null };
export async function recomputeOrderTotals(orderId: string, tx?: Prisma.TransactionClient): Promise<Totals | undefined> {
  if (!tx) return prisma.$transaction((t) => recompute(orderId, t));
  return recompute(orderId, tx);
}

async function recompute(orderId: string, db: Prisma.TransactionClient): Promise<Totals | undefined> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true, trackings: { include: { carton: { select: { route: true } } } }, payments: true,
      customer: { select: { shipRatePerKg: true, shipRateSeaPerKg: true, payCurrency: true } },
    },
  });
  if (!order) return;

  const rate = Number(order.exchangeRate ?? 0);
  const jpyCustomer = order.customer?.payCurrency === "JPY";
  // Đơn giá ship/kg: ưu tiên đặt trên tracking, không có thì lấy mặc định của khách theo tuyến kiện (bay/biển).
  // Giá khách luôn là VND -> khi fallback phải ép shipRateCurrency về "VND", nếu không trackingShipVnd sẽ tưởng vẫn
  // là JPY (cờ cũ trên tracking) và nhân nhầm thêm 1 lần tỉ giá (bug đã gây sai tổng tiền gấp hàng trăm lần).
  const trackingShip = order.trackings.reduce((s, t) => {
    const usingCustRate = t.unitPriceVndPerKg == null;
    return s + trackingShipVnd(
      { ...t, unitPriceVndPerKg: t.unitPriceVndPerKg ?? customerShipRate(order.customer, t.carton?.route), shipRateCurrency: usingCustRate ? "VND" : t.shipRateCurrency },
      rate,
    );
  }, 0);

  // 着払い/COD do kho báo theo từng mã tracking ("Phải trả kho/cty") -> cộng vào công nợ khách của đúng đơn gắn mã đó.
  // Lấy sống từ CompanyCost (không cache) -> xóa khoản là tự trừ lại ngay lần recompute sau.
  const cods = order.trackings.length
    ? await db.companyCost.findMany({
        where: { kind: "chakubarai", refId: { in: order.trackings.map((t) => t.id) } },
        select: { currency: true, amountOrig: true, amountVnd: true, exchangeRate: true },
      })
    : [];
  const ch = orderCharges(order, cods);
  const trackingNeedsRate = order.trackings.some((t) => t.shipRateCurrency === "JPY" && Number(t.unitPriceVndPerKg ?? 0) > 0);

  let totalVnd: number | null;
  let dueJpy: number | null = null;
  if (jpyCustomer) {
    // COD ¥ tính thẳng vào nợ ¥ (không quy đổi). ch.jpy đã gồm hàng/công/phí ¥; cộng COD ¥ riêng.
    dueJpy = ch.jpy + ch.codJpy;
    const codVndOnly = cods.filter((c) => c.currency !== "JPY").reduce((s, c) => s + Number(c.amountVnd ?? 0), 0);
    totalVnd = trackingNeedsRate && !rate ? null : ch.vnd + codVndOnly + trackingShip;
  } else {
    // COD ¥ có tỉ giá riêng -> dùng số ₫ đã chốt; COD ¥ không tỉ giá -> quy theo tỉ giá đơn.
    const codJpyNoRate = cods.filter((c) => c.currency === "JPY" && c.exchangeRate == null).reduce((s, c) => s + Number(c.amountOrig ?? 0), 0);
    const jpyPart = ch.jpy + codJpyNoRate;
    const hasUnconverted = (Math.abs(jpyPart) > 0 || trackingNeedsRate) && !rate;
    totalVnd = hasUnconverted ? null : jpyPart * rate + ch.vnd + ch.codVndFixed + trackingShip;
  }

  await db.order.update({ where: { id: orderId }, data: { totalQuote: ch.itemsJpy, totalVnd, dueJpy } });

  // Công nợ chỉ cập nhật khi đã có (giữ nguyên: công nợ phát sinh khi ghi tiền)
  const existing = await db.debt.findFirst({ where: { orderId } });
  if (existing) {
    // Khách trả yên: công nợ theo ¥ (dueJpy - thanh toán ¥), không lấy phần ₫ (chỉ còn tiền cân) làm nợ đơn.
    const { balance, currency } = jpyCustomer
      ? computeDebtBalance({ totalVnd: null, totalQuote: dueJpy }, order.payments)
      : computeDebtBalance({ totalVnd, totalQuote: ch.itemsJpy }, order.payments);
    await db.debt.update({ where: { id: existing.id }, data: { balance, currency } });
  }

  return { totalQuote: ch.itemsJpy, totalVnd, dueJpy };
}
