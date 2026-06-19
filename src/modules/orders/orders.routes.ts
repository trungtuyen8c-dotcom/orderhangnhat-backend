import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

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
    },
  });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  const [debt, documents] = await Promise.all([
    prisma.debt.findFirst({ where: { orderId: order.id } }),
    prisma.document.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "desc" } }),
  ]);
  res.json({ ...order, debt, documents });
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  items: z.array(z.object({
    name: z.string().min(1),
    url: z.string().optional(),
    qty: z.number().int().positive().default(1),
    unitPriceJpy: z.number().nonnegative(),
  })).min(1),
});

ordersRouter.post("/", authorize("orders.create"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const { customerId, items } = parsed.data;
  const total = items.reduce((s, i) => s + i.qty * i.unitPriceJpy, 0);

  const order = await prisma.order.create({
    data: {
      id: uuid(),
      code: `OHN-${Date.now()}`,
      customerId,
      saleId: req.user!.id,
      status: "quoted",
      totalQuote: total,
      publicToken: uuid(),
      items: { create: items },
    },
  });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.created" });
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
});

ordersRouter.patch("/:id", authorize("orders.update"), async (req, res) => {
  const p = editSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (!["draft", "quoted"].includes(order.status)) {
    return res.status(409).json({ error: "LOCKED", message: "Chỉ sửa được đơn ở trạng thái nháp/đã báo giá" });
  }
  const data: any = {};
  if (p.data.customerId) data.customerId = p.data.customerId;
  if (p.data.items) {
    data.totalQuote = p.data.items.reduce((s, i) => s + i.qty * i.unitPriceJpy, 0);
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    data.items = { create: p.data.items };
  }
  const updated = await prisma.order.update({ where: { id: order.id }, data });
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: "order.updated" });
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
