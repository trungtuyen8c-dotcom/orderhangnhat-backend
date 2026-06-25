import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit, logOrder } from "../../utils/audit.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { syncCustomerOrders } from "../../utils/gsheets.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

ordersRouter.get("/", authorize("orders.list"), async (req, res) => {
  const orders = await prisma.order.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { customer: { select: { name: true } } },
  });
  res.json(orders);
});

ordersRouter.get("/:id", authorize("orders.read"), async (req, res) => {
  const order = await prisma.order.findUnique({
    where: { id: req.params.id },
    include: {
      customer: true,
      items: true,
      trackings: { orderBy: { createdAt: "desc" } },
      payments: { orderBy: { createdAt: "asc" } },
      logs: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  const [debt, documents] = await Promise.all([
    prisma.debt.findFirst({ where: { orderId: order.id } }),
    prisma.document.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "desc" } }),
  ]);
  const logs = order.logs.map((l) => ({ ...l, id: l.id.toString() }));
  res.json({ ...order, logs, debt, documents });
});

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
};
const PRICING_FIELDS = [
  "exchangeRate", "shipAmount", "shipCurrency", "surchargeAmount", "surchargeCurrency",
  "discountAmount", "discountCurrency", "serviceFeeAmount", "serviceFeeCurrency",
  "jpDomesticShipAmount", "jpDomesticShipCurrency", "intlShipAmount", "intlShipCurrency",
] as const;

const trackingsField = z.array(z.object({
  id: z.string().uuid().optional(),
  code: z.string().min(1),
  jpWeightKg: z.number().nonnegative().optional(),
  unitPriceVndPerKg: z.number().nonnegative().optional(),
})).optional();

const createSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    name: z.string().min(1),
    url: z.string().optional(),
    qty: z.number().int().positive().default(1),
    unitPriceJpy: z.number().nonnegative(),
    shipJpy: z.number().nonnegative().optional(),
    purchaseDate: z.coerce.date().optional(),
    paymentMethod: z.string().optional(),
  })).min(1),
  trackings: trackingsField,
  ...pricingSchema,
});

// Mã đơn JA10001, JA10002... tăng dần
async function nextOrderCode(): Promise<string> {
  const last = await prisma.order.findFirst({ where: { code: { startsWith: "JA" } }, orderBy: { code: "desc" }, select: { code: true } });
  const n = last?.code ? parseInt(last.code.slice(2), 10) || 10000 : 10000;
  return `JA${n + 1}`;
}

ordersRouter.post("/", authorize("orders.create"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const d = parsed.data;
  const baseData = {
    id: uuid(),
    customerId: d.customerId,
    saleId: req.user!.id,
    status: "quoted" as const,
    exchangeRate: d.exchangeRate,
    shipAmount: d.shipAmount ?? 0,
    shipCurrency: d.shipCurrency ?? "JPY",
    surchargeAmount: d.surchargeAmount ?? 0,
    surchargeCurrency: d.surchargeCurrency ?? "VND",
    discountAmount: d.discountAmount ?? 0,
    discountCurrency: d.discountCurrency ?? "VND",
    serviceFeeAmount: d.serviceFeeAmount ?? 0,
    serviceFeeCurrency: d.serviceFeeCurrency ?? "VND",
    jpDomesticShipAmount: d.jpDomesticShipAmount ?? 0,
    jpDomesticShipCurrency: d.jpDomesticShipCurrency ?? "JPY",
    intlShipAmount: d.intlShipAmount ?? 0,
    intlShipCurrency: d.intlShipCurrency ?? "VND",
    publicToken: uuid(),
    items: { create: d.items },
  };
  // Retry nếu trùng mã do tạo đồng thời
  let order;
  for (let attempt = 0; ; attempt++) {
    try {
      order = await prisma.order.create({ data: { ...baseData, code: await nextOrderCode() } });
      break;
    } catch (e: any) {
      if (e?.code === "P2002" && attempt < 5) continue;
      throw e;
    }
  }
  if (d.trackings?.length) {
    await prisma.tracking.createMany({
      data: d.trackings.map((t) => ({ id: uuid(), orderId: order.id, code: t.code, jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg, status: "linked" })),
    });
  } else {
    // Tự tạo 1 tracking trống gắn đơn -> hiện sẵn ở bảng Chuyến, điền mã tay sau
    await prisma.tracking.create({ data: { id: uuid(), orderId: order.id, code: "", status: "linked" } });
  }
  const totals = await recomputeOrderTotals(order.id);
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.created" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "created", changes: { items: d.items.length, totalVnd: totals?.totalVnd ?? null } });
  res.status(201).json({ ...order, ...totals });
});

const ORDER_STATUSES = [
  "draft", "quoted", "deposited", "purchasing", "purchased", "jp_warehouse",
  "customs", "tax_done", "vn_warehouse", "delivered", "completed", "closed", "cancelled",
] as const;

const statusSchema = z.object({ status: z.enum(ORDER_STATUSES) });

ordersRouter.patch("/:id/status", authorize("orders.update_status"), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });

  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { status: parsed.data.status as any },
  });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.status_changed", metadata: { from: order.status, to: parsed.data.status } });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "status_changed", changes: [{ field: "status", old: order.status, new: parsed.data.status }] });
  res.json(updated);
});

// Sửa đơn (chỉ khi chưa cọc): đổi khách + thay danh sách món
const editSchema = z.object({
  customerId: z.string().uuid().optional(),
  items: z.array(z.object({
    name: z.string().min(1),
    url: z.string().optional(),
    qty: z.number().int().positive().default(1),
    unitPriceJpy: z.number().nonnegative(),
    shipJpy: z.number().nonnegative().optional(),
    purchaseDate: z.coerce.date().optional(),
    paymentMethod: z.string().optional(),
  })).min(1).optional(),
  trackings: trackingsField,
  ...pricingSchema,
});

ordersRouter.patch("/:id", authorize("orders.update"), async (req, res) => {
  const p = editSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true, trackings: true } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (!["draft", "quoted"].includes(order.status)) {
    return res.status(409).json({ error: "LOCKED", message: "Chỉ sửa được đơn ở trạng thái nháp/đã báo giá" });
  }
  const d = p.data;
  const changes: { field: string; old: unknown; new: unknown }[] = [];
  const diff = (field: string, oldV: unknown, newV: unknown) => {
    if (newV !== undefined && String(oldV ?? "") !== String(newV ?? "")) changes.push({ field, old: oldV ?? null, new: newV });
  };

  const data: any = {};
  if (d.customerId) { diff("customerId", order.customerId, d.customerId); data.customerId = d.customerId; }
  for (const f of PRICING_FIELDS) {
    const nv = (d as any)[f];
    if (nv !== undefined) { diff(f, (order as any)[f], nv); data[f] = nv; }
  }

  if (d.items) {
    diff("items", order.items.map((i) => `${i.name} x${i.qty} @${Number(i.unitPriceJpy)}`).join("; "),
      d.items.map((i) => `${i.name} x${i.qty} @${i.unitPriceJpy}`).join("; "));
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    data.items = { create: d.items };
  }

  // Upsert kiện (tracking) theo id; xóa kiện bị bỏ khỏi danh sách
  if (d.trackings !== undefined) {
    const keepIds = d.trackings.filter((t) => t.id).map((t) => t.id!);
    const toDelete = order.trackings.filter((t) => !keepIds.includes(t.id)).map((t) => t.id);
    if (toDelete.length) {
      await prisma.trackingLog.deleteMany({ where: { trackingId: { in: toDelete } } });
      await prisma.tracking.deleteMany({ where: { id: { in: toDelete } } });
    }
    for (const t of d.trackings) {
      if (t.id) await prisma.tracking.update({ where: { id: t.id }, data: { code: t.code, jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg } });
      else await prisma.tracking.create({ data: { id: uuid(), orderId: order.id, code: t.code, jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg, status: "linked" } });
    }
    diff("trackings", order.trackings.map((t) => t.code).join(", "), d.trackings.map((t) => t.code).join(", "));
  }

  await prisma.order.update({ where: { id: order.id }, data });
  const totals = await recomputeOrderTotals(order.id);
  diff("totalVnd", order.totalVnd, totals?.totalVnd ?? null);

  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  void syncCustomerOrders(order.customerId);
  if (d.customerId && d.customerId !== order.customerId) void syncCustomerOrders(d.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.updated" });
  if (changes.length) await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes });
  res.json(updated);
});

ordersRouter.delete("/:id", authorize("orders.delete"), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { payments: true, trackings: true } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (order.payments.length > 0) return res.status(409).json({ error: "HAS_PAYMENTS", message: "Đơn đã có giao dịch, không xóa được" });
  // gỡ liên kết tracking trước khi xóa đơn
  await prisma.tracking.updateMany({ where: { orderId: order.id }, data: { orderId: null, status: "new" } });
  await prisma.order.delete({ where: { id: order.id } });
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.deleted" });
  res.json({ ok: true });
});
