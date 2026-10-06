import { z } from "zod";
import { ORDER_STATUSES } from "./order.state.js";

// Nguồn "thanh toán sau" (lên đơn trước, trừ thẻ khi bấm Đã thanh toán) - không đụng thẻ lúc tạo
export const PAY_LATER_SOURCES = ["yahoo", "mercari"] as const;
export const isPayLater = (source: string) => (PAY_LATER_SOURCES as readonly string[]).includes(source);

const curEnum = z.enum(["JPY", "VND"]);
const pricingSchema = {
  exchangeRate: z.number().nonnegative().optional(),
  shipAmount: z.number().nonnegative().optional(),
  shipCurrency: curEnum.optional(),
  surchargeAmount: z.number().nonnegative().optional(),
  surchargeCurrency: curEnum.optional(),
  discountAmount: z.number().nonnegative().optional(),
  discountCurrency: curEnum.optional(),
  serviceFeeAmount: z.number().nonnegative().optional(),
  serviceFeeCurrency: curEnum.optional(),
  jpDomesticShipAmount: z.number().nonnegative().optional(),
  jpDomesticShipCurrency: curEnum.optional(),
  intlShipAmount: z.number().nonnegative().optional(),
  intlShipCurrency: curEnum.optional(),
  commissionPercent: z.number().min(0).max(100).optional(),
};
export const PRICING_FIELDS = [
  "exchangeRate", "shipAmount", "shipCurrency", "surchargeAmount", "surchargeCurrency",
  "discountAmount", "discountCurrency", "serviceFeeAmount", "serviceFeeCurrency",
  "jpDomesticShipAmount", "jpDomesticShipCurrency", "intlShipAmount", "intlShipCurrency",
  "commissionPercent",
] as const;

const trackingsField = z.array(z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(1),
  jpWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
})).optional();

const itemSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  qty: z.number().int().positive().default(1),
  unitPriceJpy: z.number().nonnegative(),
  shipJpy: z.number().nonnegative().optional(),
  purchaseDate: z.coerce.date().optional(),
  paymentMethod: z.string().optional(),
});

export const createSchema = z.object({
  customerId: z.string().uuid(),
  orderDate: z.coerce.date().optional(),
  source: z.enum(["normal", "yahoo", "mercari"]).optional(),
  nick: z.string().optional(),
  items: z.array(itemSchema).min(1),
  trackings: trackingsField,
  needsCheck: z.boolean().optional(),
  checkNote: z.string().optional(),
  externalWarehouse: z.boolean().optional(),
  skipVnWeighing: z.boolean().optional(),
  ...pricingSchema,
});
export type CreateOrderInput = z.infer<typeof createSchema>;

// Hàng ký gửi / khách tự đem (chỉ vận chuyển, không mua qua mình): đơn không có món mua
export const consignSchema = z.object({
  customerId: z.string().uuid(),
  code: z.string().min(1),
  jpWeightKg: z.number().nonnegative().optional(),
  vnWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
  shipRateCurrency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  packedAt: z.coerce.date().optional(),
  review: z.string().optional(),
});
export type ConsignmentInput = z.infer<typeof consignSchema>;

export const statusSchema = z.object({ status: z.enum(ORDER_STATUSES) });

// Sửa đơn (chỉ khi chưa cọc): đổi khách + thay danh sách món
export const editSchema = z.object({
  customerId: z.string().uuid().optional(),
  orderDate: z.coerce.date().optional(),
  nick: z.string().optional(),
  items: z.array(itemSchema).min(1).optional(),
  trackings: trackingsField,
  needsCheck: z.boolean().optional(),
  checkNote: z.string().optional(),
  externalWarehouse: z.boolean().optional(),
  skipVnWeighing: z.boolean().optional(),
  ...pricingSchema,
});
export type EditOrderInput = z.infer<typeof editSchema>;

// Yahoo/Mercari "thanh toán sau": bấm đã TT -> chọn thẻ + ngày -> lúc này mới trừ thẻ
export const paySchema = z.object({ walletId: z.string().uuid(), paidAt: z.coerce.date().optional() });

// Kế toán yêu cầu sale sửa đơn (khi giao dịch/tiền sai)
export const fixSchema = z.object({ note: z.string().min(1) });
