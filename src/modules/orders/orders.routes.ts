import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit, logOrder } from "../../utils/audit.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

type Cur = "JPY" | "VND";
interface PricingInput {
  items: { qty: number; unitPriceJpy: number }[];
  exchangeRate?: number | null;
  shipAmount?: number; shipCurrency?: Cur;
  surchargeAmount?: number; surchargeCurrency?: Cur;
  discountAmount?: number; discountCurrency?: Cur;
}

// totalQuote = tổng JPY của món; totalVnd = quy đổi + phí (JPY x tỉ giá, VND cộng thẳng)
function computeTotals(p: PricingInput) {
  const subtotalJpy = p.items.reduce((s, i) => s + i.qty * i.unitPriceJpy, 0);
  const rate = Number(p.exchangeRate ?? 0);
  const toVnd = (amt = 0, cur: Cur = "VND") => (cur === "JPY" ? amt * rate : amt);
  const totalVnd = rate
    ? subtotalJpy * rate
      + toVnd(p.shipAmount, p.shipCurrency)
      + toVnd(p.surchargeAmount, p.surchargeCurrency)
      - toVnd(p.discountAmount, p.discountCurrency)
    : null;
  return { totalQuote: subtotalJpy, totalVnd };
}

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
};

const createSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    name: z.string().min(1),
    url: z.string().optional(),
    qty: z.number().int().positive().default(1),
    unitPriceJpy: z.number().nonnegative(),
  })).min(1),
  ...pricingSchema,
});

ordersRouter.post("/", authorize("orders.create"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const d = parsed.data;
  const { totalQuote, totalVnd } = computeTotals(d);

  const order = await prisma.order.create({
    data: {
      id: uuid(),
      code: `OHN-${Date.now()}`,
      customerId: d.customerId,
      saleId: req.user!.id,
      status: "quoted",
      totalQuote,
      totalVnd,
      exchangeRate: d.exchangeRate,
      shipAmount: d.shipAmount ?? 0,
      shipCurrency: d.shipCurrency ?? "JPY",
      surchargeAmount: d.surchargeAmount ?? 0,
      surchargeCurrency: d.surchargeCurrency ?? "VND",
      discountAmount: d.discountAmount ?? 0,
      discountCurrency: d.discountCurrency ?? "VND",
      publicToken: uuid(),
      items: { create: d.items },
    },
  });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.created" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "created", changes: { items: d.items.length, totalVnd } });
  res.status(201).json(order);
});

// State machine hợp lệ
const NEXT: Record<string, string[]> = {
  draft: ["quoted", "closed"],
  quoted: ["deposited", "closed"],
  deposited: ["purchasing", "cancelled"],
  purchasing: ["purchased", "cancelled"],
  purchased: ["jp_warehouse"],
  jp_warehouse: ["customs"],
  customs: ["tax_done"],
  tax_done: ["vn_warehouse"],
  vn_warehouse: ["delivered"],
  delivered: ["completed"],
};

const statusSchema = z.object({ status: z.string() });

ordersRouter.patch("/:id/status", authorize("orders.update_status"), async (req, res) => {
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });

  const allowed = NEXT[order.status] ?? [];
  if (!allowed.includes(parsed.data.status)) {
    return res.status(409).json({ error: "INVALID_TRANSITION", from: order.status, allowed });
  }
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
  })).min(1).optional(),
  ...pricingSchema,
});

ordersRouter.patch("/:id", authorize("orders.update"), async (req, res) => {
  const p = editSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
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
  diff("exchangeRate", order.exchangeRate, d.exchangeRate); if (d.exchangeRate !== undefined) data.exchangeRate = d.exchangeRate;
  diff("shipAmount", order.shipAmount, d.shipAmount); if (d.shipAmount !== undefined) data.shipAmount = d.shipAmount;
  diff("shipCurrency", order.shipCurrency, d.shipCurrency); if (d.shipCurrency !== undefined) data.shipCurrency = d.shipCurrency;
  diff("surchargeAmount", order.surchargeAmount, d.surchargeAmount); if (d.surchargeAmount !== undefined) data.surchargeAmount = d.surchargeAmount;
  diff("surchargeCurrency", order.surchargeCurrency, d.surchargeCurrency); if (d.surchargeCurrency !== undefined) data.surchargeCurrency = d.surchargeCurrency;
  diff("discountAmount", order.discountAmount, d.discountAmount); if (d.discountAmount !== undefined) data.discountAmount = d.discountAmount;
  diff("discountCurrency", order.discountCurrency, d.discountCurrency); if (d.discountCurrency !== undefined) data.discountCurrency = d.discountCurrency;

  const items = d.items ?? order.items.map((i) => ({ qty: i.qty, unitPriceJpy: Number(i.unitPriceJpy), name: i.name, url: i.url ?? undefined }));
  if (d.items) {
    diff("items", order.items.map((i) => `${i.name} x${i.qty} @${Number(i.unitPriceJpy)}`).join("; "),
      d.items.map((i) => `${i.name} x${i.qty} @${i.unitPriceJpy}`).join("; "));
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    data.items = { create: d.items };
  }

  const { totalQuote, totalVnd } = computeTotals({
    items,
    exchangeRate: d.exchangeRate ?? (Number(order.exchangeRate ?? 0) || undefined),
    shipAmount: d.shipAmount ?? Number(order.shipAmount), shipCurrency: (d.shipCurrency ?? order.shipCurrency) as Cur,
    surchargeAmount: d.surchargeAmount ?? Number(order.surchargeAmount), surchargeCurrency: (d.surchargeCurrency ?? order.surchargeCurrency) as Cur,
    discountAmount: d.discountAmount ?? Number(order.discountAmount), discountCurrency: (d.discountCurrency ?? order.discountCurrency) as Cur,
  });
  data.totalQuote = totalQuote;
  data.totalVnd = totalVnd;
  diff("totalVnd", order.totalVnd, totalVnd);

  const updated = await prisma.order.update({ where: { id: order.id }, data });
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
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.deleted" });
  res.json({ ok: true });
});
