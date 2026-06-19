import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const accountingRouter = Router();
accountingRouter.use(authenticate);

async function recomputeDebt(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
  if (!order) return;
  const paid = order.payments.reduce((s, p) => {
    const amt = Number(p.amountVnd);
    return p.type === "refund" ? s - amt : s + amt;
  }, 0);
  const balance = Number(order.totalQuote ?? 0) - paid;
  const existing = await prisma.debt.findFirst({ where: { orderId } });
  if (existing) await prisma.debt.update({ where: { id: existing.id }, data: { balance } });
  else await prisma.debt.create({ data: { id: uuid(), orderId, customerId: order.customerId, balance } });
}

const paymentSchema = z.object({
  type: z.enum(["deposit", "final", "refund"]),
  amountVnd: z.number().positive(),
  walletId: z.string().uuid().optional(),
});

// Ghi cọc / thu nốt / hoàn -> cập nhật công nợ + ví
accountingRouter.post("/orders/:id/payments", authorize("accounting.record_payment"), async (req, res) => {
  const p = paymentSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!order) return res.status(404).json({ error: "NOT_FOUND" });
  if (p.data.type === "refund" && !req.user!.roles.some((r) => ["super_admin", "admin", "accountant"].includes(r))) {
    // refund cần quyền refund
    const has = await prisma.permission.count({ where: { key: "accounting.refund", roles: { some: { role: { users: { some: { userId: req.user!.id } } } } } } });
    if (!has) return res.status(403).json({ error: "FORBIDDEN", message: "Thiếu quyền accounting.refund" });
  }

  const payment = await prisma.payment.create({
    data: { id: uuid(), orderId: order.id, type: p.data.type, amountVnd: p.data.amountVnd, walletId: p.data.walletId || null, recordedBy: req.user!.id },
  });

  if (p.data.type === "deposit") {
    await prisma.order.update({ where: { id: order.id }, data: { deposit: { increment: p.data.amountVnd }, paidAt: order.paidAt ?? new Date() } });
  }

  if (p.data.walletId) {
    const sign = p.data.type === "refund" ? -1 : 1;
    await prisma.wallet.update({ where: { id: p.data.walletId }, data: { balance: { increment: sign * p.data.amountVnd } } });
    await prisma.walletTxn.create({ data: { id: uuid(), walletId: p.data.walletId, amount: sign * p.data.amountVnd, type: p.data.type, refOrderId: order.id } });
  }

  await recomputeDebt(order.id);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: `payment.${p.data.type}`, metadata: { amount: p.data.amountVnd } });
  const debt = await prisma.debt.findFirst({ where: { orderId: order.id } });
  res.status(201).json({ payment, debt });
});

accountingRouter.get("/orders/:id/payments", authorize("orders.read"), async (req, res) => {
  const payments = await prisma.payment.findMany({ where: { orderId: req.params.id }, orderBy: { createdAt: "asc" } });
  const debt = await prisma.debt.findFirst({ where: { orderId: req.params.id } });
  res.json({ payments, debt });
});

accountingRouter.get("/wallets", authorize("accounting.reconcile"), async (_req, res) => {
  const wallets = await prisma.wallet.findMany({ orderBy: { name: "asc" } });
  res.json(wallets);
});

const walletSchema = z.object({ name: z.string().min(1), currency: z.string().default("VND") });
accountingRouter.post("/wallets", authorize("wallets.manage"), async (req, res) => {
  const p = walletSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (await prisma.wallet.findUnique({ where: { name: p.data.name } })) return res.status(409).json({ error: "WALLET_EXISTS" });
  const w = await prisma.wallet.create({ data: { id: uuid(), name: p.data.name, currency: p.data.currency } });
  await logAudit({ actorId: req.user!.id, targetId: w.id, action: "wallet.created" });
  res.status(201).json(w);
});

accountingRouter.patch("/wallets/:id", authorize("wallets.manage"), async (req, res) => {
  const p = walletSchema.partial().safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const w = await prisma.wallet.update({ where: { id: req.params.id }, data: p.data });
  await logAudit({ actorId: req.user!.id, targetId: w.id, action: "wallet.updated" });
  res.json(w);
});

accountingRouter.delete("/wallets/:id", authorize("wallets.manage"), async (req, res) => {
  const txns = await prisma.walletTxn.count({ where: { walletId: req.params.id } });
  if (txns > 0) return res.status(409).json({ error: "HAS_TXNS", message: "Ví còn giao dịch, không xóa được" });
  await prisma.wallet.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "wallet.deleted" });
  res.json({ ok: true });
});

// Đối soát: liệt kê giao dịch chưa đối soát theo ví
accountingRouter.get("/reconcile", authorize("accounting.reconcile"), async (_req, res) => {
  const txns = await prisma.walletTxn.findMany({ where: { reconciled: false }, orderBy: { createdAt: "desc" }, take: 300, include: { wallet: { select: { name: true } } } });
  res.json(txns);
});

const reconcileSchema = z.object({ statementRef: z.string().optional() });
accountingRouter.post("/wallet-txns/:id/reconcile", authorize("accounting.reconcile"), async (req, res) => {
  const p = reconcileSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const txn = await prisma.walletTxn.update({ where: { id: req.params.id }, data: { reconciled: true, statementRef: p.data.statementRef } });
  await logAudit({ actorId: req.user!.id, targetId: txn.id, action: "wallet_txn.reconciled" });
  res.json(txn);
});
