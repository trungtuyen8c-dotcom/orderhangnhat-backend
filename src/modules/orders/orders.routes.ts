import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit, logOrder } from "../../utils/audit.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { applyOrderCardCharges, reverseOrderCardCharges } from "../../utils/orderCard.js";
import { syncCustomerOrders } from "../../utils/gsheets.js";
import { detectMarketplace } from "../../utils/scrape.js";

export const ordersRouter = Router();
ordersRouter.use(authenticate);

// Nguồn "thanh toán sau" (lên đơn trước, trừ thẻ khi bấm Đã thanh toán) - không đụng thẻ lúc tạo
const PAY_LATER_SOURCES = ["yahoo", "mercari"] as const;

// Chặn dán nhầm link Yahoo vào đơn Mercari và ngược lại (source phải khớp domain link món hàng)
function findWrongMarketplaceUrl(source: string, items: { url?: string }[]): string | null {
  if (source !== "yahoo" && source !== "mercari") return null;
  for (const i of items) {
    if (!i.url) continue;
    const detected = detectMarketplace(i.url);
    if (detected && detected !== source) return i.url;
  }
  return null;
}

ordersRouter.get("/", authorize("orders.list"), async (req, res) => {
  const src = String(req.query.source ?? "");
  const excludeList = String(req.query.exclude ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const isPayLater = (PAY_LATER_SOURCES as readonly string[]).includes(src);
  const where = isPayLater ? { source: src }
    : excludeList.length ? { source: { notIn: excludeList } } : undefined;
  const orders = await prisma.order.findMany({
    where,
    orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
    include: {
      customer: { select: { name: true } },
      trackings: { select: { id: true, code: true, review: true, url: true }, orderBy: { createdAt: "asc" } },
      items: isPayLater
        ? { select: { unitPriceJpy: true, qty: true, shipJpy: true, url: true, paymentMethod: true } }
        : { select: { url: true, paymentMethod: true } },
    },
  });
  res.json(orders);
});

// Đơn bị kế toán yêu cầu sửa, chưa xử lý xong -> hiện chuông thông báo cho sale
ordersRouter.get("/fix-requests", authorize("orders.update"), async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { fixRequest: { not: null } },
    orderBy: { fixRequestedAt: "desc" },
    take: 50,
    select: { id: true, code: true, fixRequest: true, customer: { select: { name: true } } },
  });
  res.json(orders.map((o) => ({ id: o.id, code: o.code, fixRequest: o.fixRequest, customer: o.customer?.name ?? null })));
});

// Cảnh báo trùng link sản phẩm / mã tracking với đơn khác - để sale tự xác nhận trước khi lưu, không tự chặn.
ordersRouter.get("/check-duplicate", authorize("orders.list"), async (req, res) => {
  const url = String(req.query.url ?? "").trim();
  const code = String(req.query.code ?? "").trim();
  const excludeOrderId = String(req.query.excludeOrderId ?? "").trim();
  const urlOrders = url
    ? await prisma.orderItem.findMany({
        where: { url, ...(excludeOrderId ? { orderId: { not: excludeOrderId } } : {}) },
        select: { order: { select: { code: true } } },
      })
    : [];
  const codeOrders = code
    ? await prisma.tracking.findMany({
        where: { code, orderId: { not: null }, ...(excludeOrderId ? { NOT: { orderId: excludeOrderId } } : {}) },
        select: { order: { select: { code: true } } },
      })
    : [];
  res.json({
    urlOrders: [...new Set(urlOrders.map((i) => i.order.code))],
    codeOrders: [...new Set(codeOrders.map((t) => t.order!.code))],
  });
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
  orderDate: z.coerce.date().optional(),
  source: z.enum(["normal", "yahoo", "mercari"]).optional(),
  nick: z.string().optional(),
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
  needsCheck: z.boolean().optional(),
  checkNote: z.string().optional(),
  externalWarehouse: z.boolean().optional(),
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
  const wrongUrl = findWrongMarketplaceUrl(d.source ?? "normal", d.items);
  if (wrongUrl) return res.status(400).json({ error: "WRONG_MARKETPLACE", message: `Link không khớp: ${wrongUrl}` });
  const baseData = {
    id: uuid(),
    customerId: d.customerId,
    saleId: req.user!.id,
    status: "quoted" as const,
    orderDate: d.orderDate ?? new Date(),
    source: d.source ?? "normal",
    nick: d.nick ?? null,
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
    needsCheck: d.needsCheck ?? false,
    checkNote: d.checkNote ?? null,
    externalWarehouse: d.externalWarehouse ?? false,
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
  // Yahoo/Mercari (thanh toán sau): KHÔNG trừ thẻ lúc tạo, chỉ trừ khi bấm "Đã thanh toán"
  if (!(PAY_LATER_SOURCES as readonly string[]).includes(d.source ?? "normal"))
    await applyOrderCardCharges(prisma, { orderId: order.id, code: order.code, items: d.items, exchangeRate: d.exchangeRate, fallbackDate: order.orderDate });
  const totals = await recomputeOrderTotals(order.id);
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.created" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "created", changes: { items: d.items.length, totalVnd: totals?.totalVnd ?? null } });
  res.status(201).json({ ...order, ...totals });
});

// Hàng ký gửi / khách tự đem (chỉ vận chuyển, không mua qua mình): đơn không có món mua
const consignSchema = z.object({
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
ordersRouter.post("/consignment", authorize("orders.create"), async (req, res) => {
  const p = consignSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const d = p.data;
  if (d.shipRateCurrency === "JPY" && !d.exchangeRate) return res.status(400).json({ error: "BAD_REQUEST", message: "Đơn giá JPY/kg cần nhập tỉ giá" });
  let order;
  for (let attempt = 0; ; attempt++) {
    try {
      order = await prisma.order.create({ data: {
        id: uuid(), customerId: d.customerId, saleId: req.user!.id, status: "vn_warehouse",
        exchangeRate: d.exchangeRate ?? null, publicToken: uuid(), code: await nextOrderCode(),
      } });
      break;
    } catch (e: any) { if (e?.code === "P2002" && attempt < 5) continue; throw e; }
  }
  await prisma.tracking.create({ data: {
    id: uuid(), orderId: order.id, code: d.code, jpWeightKg: d.jpWeightKg ?? null, vnWeightKg: d.vnWeightKg ?? null,
    unitPriceVndPerKg: d.unitPriceVndPerKg ?? null, shipRateCurrency: d.shipRateCurrency,
    review: d.review ?? null, packedAt: d.packedAt ?? null, status: "linked",
  } });
  const totals = await recomputeOrderTotals(order.id);
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.consignment_created" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "created", changes: { consignment: true, totalVnd: totals?.totalVnd ?? null } });
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
  orderDate: z.coerce.date().optional(),
  nick: z.string().optional(),
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
  needsCheck: z.boolean().optional(),
  checkNote: z.string().optional(),
  externalWarehouse: z.boolean().optional(),
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
  if (d.items) {
    const wrongUrl = findWrongMarketplaceUrl(order.source, d.items);
    if (wrongUrl) return res.status(400).json({ error: "WRONG_MARKETPLACE", message: `Link không khớp: ${wrongUrl}` });
  }
  const changes: { field: string; old: unknown; new: unknown }[] = [];
  const diff = (field: string, oldV: unknown, newV: unknown) => {
    if (newV !== undefined && String(oldV ?? "") !== String(newV ?? "")) changes.push({ field, old: oldV ?? null, new: newV });
  };

  const data: any = {};
  if (d.orderDate !== undefined) { diff("orderDate", order.orderDate, d.orderDate); data.orderDate = d.orderDate; }
  if (d.needsCheck !== undefined) { diff("needsCheck", order.needsCheck, d.needsCheck); data.needsCheck = d.needsCheck; }
  if (d.checkNote !== undefined) { diff("checkNote", order.checkNote, d.checkNote); data.checkNote = d.checkNote; }
  if (d.externalWarehouse !== undefined) { diff("externalWarehouse", order.externalWarehouse, d.externalWarehouse); data.externalWarehouse = d.externalWarehouse; }
  if (d.customerId) { diff("customerId", order.customerId, d.customerId); data.customerId = d.customerId; }
  if (d.nick !== undefined) { diff("nick", order.nick, d.nick); data.nick = d.nick; }
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
  // Yahoo/Mercari chưa thanh toán -> không đụng thẻ; đã TT thì tính lại theo món mới
  if (d.items && (!(PAY_LATER_SOURCES as readonly string[]).includes(order.source) || order.yahooPaidAt)) {
    await reverseOrderCardCharges(prisma, order.id);
    await applyOrderCardCharges(prisma, { orderId: order.id, code: order.code, items: d.items, exchangeRate: d.exchangeRate ?? order.exchangeRate, fallbackDate: d.orderDate ?? order.orderDate });
  }
  const totals = await recomputeOrderTotals(order.id);
  diff("totalVnd", order.totalVnd, totals?.totalVnd ?? null);

  const updated = await prisma.order.findUnique({ where: { id: order.id } });
  void syncCustomerOrders(order.customerId);
  if (d.customerId && d.customerId !== order.customerId) void syncCustomerOrders(d.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.updated" });
  if (changes.length) await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes });
  res.json(updated);
});

// Yahoo/Mercari "thanh toán sau": bấm đã TT -> chọn thẻ + ngày -> lúc này mới trừ thẻ
const paySchema = z.object({ walletId: z.string().uuid(), paidAt: z.coerce.date().optional() });
ordersRouter.post("/:id/pay", authorize("orders.update"), async (req, res) => {
  const p = paySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(PAY_LATER_SOURCES as readonly string[]).includes(order.source)) return res.status(409).json({ error: "NOT_YAHOO", message: "Chỉ đơn Yahoo/Mercari mới thanh toán sau" });
  if (order.yahooPaidAt) return res.status(409).json({ error: "ALREADY_PAID", message: "Đơn đã thanh toán" });
  const wallet = await prisma.wallet.findUnique({ where: { id: p.data.walletId } });
  if (!wallet) return res.status(404).json({ error: "WALLET_NOT_FOUND" });
  // gán thẻ vào tất cả món rồi trừ (dùng chung logic auto-charge)
  await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { paymentMethod: wallet.name } });
  const paidAt = p.data.paidAt ?? new Date();
  const items = order.items.map((i) => ({ unitPriceJpy: i.unitPriceJpy, qty: i.qty, shipJpy: i.shipJpy, paymentMethod: wallet.name, purchaseDate: i.purchaseDate }));
  // Ngày ghi sổ ưu tiên: ngày mua món (nếu có) -> ngày đặt đơn -> KHÔNG dùng ngày bấm "Đã thanh toán"
  // (kế toán có thể xác nhận trễ nhiều ngày, dồn hết giao dịch vào 1 ngày là sai thực tế).
  await applyOrderCardCharges(prisma, { orderId: order.id, code: order.code, items, exchangeRate: order.exchangeRate, fallbackDate: order.orderDate });
  await prisma.order.update({ where: { id: order.id }, data: { yahooPaidAt: paidAt } });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.yahoo_paid", metadata: { wallet: wallet.name } });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes: { yahooThanhToan: wallet.name } });
  res.json({ ok: true });
});

// Hủy thanh toán Yahoo/Mercari -> hoàn tiền về thẻ
ordersRouter.post("/:id/unpay", authorize("orders.update"), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (!(PAY_LATER_SOURCES as readonly string[]).includes(order.source) || !order.yahooPaidAt) return res.status(409).json({ error: "NOT_PAID", message: "Đơn chưa thanh toán" });
  await reverseOrderCardCharges(prisma, order.id);
  await prisma.order.update({ where: { id: order.id }, data: { yahooPaidAt: null } });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.yahoo_unpaid" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes: { yahooHuyThanhToan: true } });
  res.json({ ok: true });
});

// Kế toán yêu cầu sale sửa đơn (khi giao dịch/tiền sai)
const fixSchema = z.object({ note: z.string().min(1) });
ordersRouter.post("/:id/request-fix", authorize("accounting.reconcile"), async (req, res) => {
  const p = fixSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST", message: "Nhập nội dung yêu cầu sửa" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  await prisma.order.update({ where: { id: order.id }, data: { fixRequest: p.data.note, fixRequestedAt: new Date() } });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.fix_requested", metadata: { note: p.data.note } });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes: { yeuCauSua: p.data.note } });
  res.json({ ok: true });
});

// Sale đánh dấu đã sửa xong -> gỡ yêu cầu
ordersRouter.post("/:id/resolve-fix", authorize("orders.update"), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  await prisma.order.update({ where: { id: order.id }, data: { fixRequest: null, fixRequestedAt: null } });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.fix_resolved" });
  await logOrder({ orderId: order.id, actorId: req.user!.id, action: "updated", changes: { daSuaXong: true } });
  res.json({ ok: true });
});

ordersRouter.delete("/:id", authorize("orders.delete"), async (req, res) => {
  const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { payments: true, trackings: true } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  const force = req.query.force === "1" || req.query.force === "true";
  if (order.payments.length > 0) {
    if (!force) return res.status(409).json({ error: "HAS_PAYMENTS", message: "Đơn đã có giao dịch, không xóa được" });
    // Force chỉ cho admin/super_admin: xóa cả giao dịch + hoàn lại số dư ví
    if (!req.user!.roles.some((r) => ["super_admin", "admin"].includes(r)))
      return res.status(403).json({ error: "FORBIDDEN", message: "Chỉ Admin được xóa đơn đã có giao dịch" });
    await prisma.$transaction(async (tx) => {
      for (const p of order.payments) {
        if (p.walletId) {
          const sign = p.type === "refund" ? -1 : 1;
          await tx.wallet.update({ where: { id: p.walletId }, data: { balance: { decrement: sign * Number(p.amountOrig) } } });
        }
      }
      await reverseOrderCardCharges(tx, order.id);
      await tx.walletTxn.deleteMany({ where: { refOrderId: order.id } });
      await tx.payment.deleteMany({ where: { orderId: order.id } });
      await tx.debt.deleteMany({ where: { orderId: order.id } });
      // Tracking chưa gõ mã (code rỗng, chỉ là placeholder chờ điền) -> xóa luôn, không để mồ côi vô nghĩa
      await tx.tracking.deleteMany({ where: { orderId: order.id, code: "" } });
      await tx.tracking.updateMany({ where: { orderId: order.id }, data: { orderId: null, status: "new" } });
      await tx.order.delete({ where: { id: order.id } });
    });
    void syncCustomerOrders(order.customerId);
    await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.force_deleted", metadata: { payments: order.payments.length } });
    return res.json({ ok: true });
  }
  // hoàn số dư thẻ (Mua hàng auto) + gỡ liên kết tracking trước khi xóa đơn
  await reverseOrderCardCharges(prisma, order.id);
  // Tracking chưa gõ mã (code rỗng, chỉ là placeholder chờ điền) -> xóa luôn, không để mồ côi vô nghĩa
  await prisma.tracking.deleteMany({ where: { orderId: order.id, code: "" } });
  await prisma.tracking.updateMany({ where: { orderId: order.id }, data: { orderId: null, status: "new" } });
  await prisma.order.delete({ where: { id: order.id } });
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.deleted" });
  res.json({ ok: true });
});
