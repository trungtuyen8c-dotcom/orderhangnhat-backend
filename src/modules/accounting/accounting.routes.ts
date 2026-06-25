import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { syncCustomerOrders } from "../../utils/gsheets.js";

export const accountingRouter = Router();
accountingRouter.use(authenticate);

async function recomputeDebt(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true } });
  if (!order) return;
  const paid = order.payments.reduce((s, p) => {
    const amt = Number(p.amountVnd);
    return p.type === "refund" ? s - amt : s + amt;
  }, 0);
  const balance = Number(order.totalVnd ?? order.totalQuote ?? 0) - paid;
  const existing = await prisma.debt.findFirst({ where: { orderId } });
  if (existing) await prisma.debt.update({ where: { id: existing.id }, data: { balance } });
  else await prisma.debt.create({ data: { id: uuid(), orderId, customerId: order.customerId, balance } });
}

const paymentSchema = z.object({
  type: z.enum(["deposit", "final", "refund"]),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  method: z.string().optional(),
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

  // Quy đổi sang VND để tính công nợ (công nợ luôn theo VND)
  if (p.data.currency === "JPY" && !p.data.exchangeRate) return res.status(400).json({ error: "BAD_REQUEST", message: "Thu JPY cần nhập tỉ giá" });
  const amountVnd = p.data.currency === "JPY" ? Math.round(p.data.amount * p.data.exchangeRate!) : p.data.amount;

  // Ví phải cùng tiền tệ với khoản thu
  if (p.data.walletId) {
    const wallet = await prisma.wallet.findUnique({ where: { id: p.data.walletId } });
    if (!wallet) return res.status(404).json({ error: "WALLET_NOT_FOUND" });
    if (wallet.currency !== p.data.currency) return res.status(400).json({ error: "CURRENCY_MISMATCH", message: `Ví ${wallet.name} là ${wallet.currency}, không nhận ${p.data.currency}` });
  }

  const payment = await prisma.payment.create({
    data: {
      id: uuid(), orderId: order.id, type: p.data.type, amountVnd,
      currency: p.data.currency, amountOrig: p.data.amount, exchangeRate: p.data.exchangeRate ?? null,
      method: p.data.method || null, walletId: p.data.walletId || null, recordedBy: req.user!.id,
    },
  });

  if (p.data.type === "deposit") {
    await prisma.order.update({ where: { id: order.id }, data: { deposit: { increment: amountVnd }, paidAt: order.paidAt ?? new Date() } });
  }

  if (p.data.walletId) {
    const sign = p.data.type === "refund" ? -1 : 1;
    // Ví ghi theo tiền tệ gốc của ví (đã kiểm tra trùng tiền tệ ở trên)
    await prisma.wallet.update({ where: { id: p.data.walletId }, data: { balance: { increment: sign * p.data.amount } } });
    await prisma.walletTxn.create({ data: { id: uuid(), walletId: p.data.walletId, amount: sign * p.data.amount, type: p.data.type, refOrderId: order.id } });
  }

  await recomputeDebt(order.id);
  void syncCustomerOrders(order.customerId);
  await logAudit({ actorId: req.user!.id, targetId: order.id, action: `payment.${p.data.type}`, metadata: { amount: p.data.amount, currency: p.data.currency, amountVnd } });
  const debt = await prisma.debt.findFirst({ where: { orderId: order.id } });
  res.status(201).json({ payment, debt });
});

accountingRouter.get("/orders/:id/payments", authorize("orders.read"), async (req, res) => {
  const payments = await prisma.payment.findMany({ where: { orderId: req.params.id }, orderBy: { createdAt: "asc" } });
  const debt = await prisma.debt.findFirst({ where: { orderId: req.params.id } });
  res.json({ payments, debt });
});

// Công nợ gộp theo khách: mỗi khách còn nợ bao nhiêu
accountingRouter.get("/debts", authorize("orders.read"), async (_req, res) => {
  const grouped = await prisma.debt.groupBy({
    by: ["customerId"],
    _sum: { balance: true },
    _max: { updatedAt: true },
  });
  const ids = grouped.map((g) => g.customerId);
  const customers = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, phone: true },
  });
  const map = new Map(customers.map((c) => [c.id, c]));
  const rows = grouped
    .map((g) => ({
      customerId: g.customerId,
      code: g.customerId.slice(0, 8).toUpperCase(),
      name: map.get(g.customerId)?.name ?? "?",
      phone: map.get(g.customerId)?.phone ?? null,
      balance: Number(g._sum.balance ?? 0),
      updatedAt: g._max.updatedAt,
    }))
    .filter((r) => r.balance !== 0)
    .sort((a, b) => b.balance - a.balance);
  res.json(rows);
});

// ===== Ví khách: cọc cục + đối soát theo tháng =====
// Còn nợ khách = tổng đơn (VND) - (cọc cục + thanh toán theo đơn).
async function customerLedger(customerId: string) {
  const orders = await prisma.order.findMany({
    where: { customerId, status: { not: "cancelled" } },
    select: { totalVnd: true, createdAt: true },
  });
  const deposits = await prisma.customerDeposit.findMany({ where: { customerId }, orderBy: { paidAt: "desc" } });
  const payments = await prisma.payment.findMany({ where: { order: { customerId } }, select: { amountVnd: true, type: true, createdAt: true } });

  // Chỉ cọc đã xác nhận (tiền thật vào) mới trừ công nợ. Cọc chờ -> pendingTotal.
  const confirmed = deposits.filter((d) => d.confirmed);
  const orderTotal = orders.reduce((s, o) => s + Number(o.totalVnd ?? 0), 0);
  const depositTotal = confirmed.reduce((s, d) => s + Number(d.amountVnd), 0);
  const pendingTotal = deposits.filter((d) => !d.confirmed).reduce((s, d) => s + Number(d.amountVnd), 0);
  const paymentTotal = payments.reduce((s, p) => s + (p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd)), 0);
  const paidTotal = depositTotal + paymentTotal;
  const debt = orderTotal - paidTotal;

  const mk = (d: Date) => `${new Date(d).getFullYear()}-${String(new Date(d).getMonth() + 1).padStart(2, "0")}`;
  const months = new Map<string, { order: number; paid: number }>();
  const bump = (k: string, f: "order" | "paid", v: number) => { const m = months.get(k) ?? { order: 0, paid: 0 }; m[f] += v; months.set(k, m); };
  for (const o of orders) bump(mk(o.createdAt), "order", Number(o.totalVnd ?? 0));
  for (const d of confirmed) bump(mk(d.paidAt), "paid", Number(d.amountVnd));
  for (const p of payments) bump(mk(p.createdAt), "paid", p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd));

  let run = 0;
  const byMonth = [...months.keys()].sort().map((month) => {
    const m = months.get(month)!;
    run += m.paid - m.order;
    return { month, order: m.order, paid: m.paid, balance: run };
  });
  return { orderTotal, depositTotal, pendingTotal, paymentTotal, paidTotal, debt, deposits, byMonth };
}

accountingRouter.get("/customers/:id/ledger", authorize("orders.read"), async (req, res) => {
  res.json(await customerLedger(req.params.id));
});

const depositSchema = z.object({
  amountVnd: z.number().positive(),
  payerName: z.string().optional(),
  method: z.string().optional(),
  walletId: z.string().uuid().optional(),
  note: z.string().optional(),
  paidAt: z.coerce.date().optional(),
});
// NV ghi cọc -> trạng thái CHỜ (chưa cộng ví, chưa trừ nợ). Kế toán xác nhận sau.
accountingRouter.post("/customers/:id/deposits", authorize("accounting.record_payment"), async (req, res) => {
  const p = depositSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const customer = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!customer) return res.status(404).json({ error: "NOT_FOUND" });
  if (p.data.walletId) {
    const w = await prisma.wallet.findUnique({ where: { id: p.data.walletId } });
    if (!w) return res.status(404).json({ error: "WALLET_NOT_FOUND" });
    if (w.currency !== "VND") return res.status(400).json({ error: "CURRENCY_MISMATCH", message: "Cọc khách phải vào ví VND" });
  }
  const dep = await prisma.customerDeposit.create({
    data: { id: uuid(), customerId: req.params.id, amountVnd: p.data.amountVnd, payerName: p.data.payerName || null, method: p.data.method || null, walletId: p.data.walletId || null, note: p.data.note || null, paidAt: p.data.paidAt ?? new Date(), recordedBy: req.user!.id },
  });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "customer.deposit", metadata: { amountVnd: p.data.amountVnd, confirmed: false } });
  res.status(201).json(dep);
});

// Kế toán bấm tích: tiền thật đã vào -> cộng ví + trừ nợ
accountingRouter.post("/customer-deposits/:id/confirm", authorize("accounting.reconcile"), async (req, res) => {
  const dep = await prisma.customerDeposit.findUnique({ where: { id: req.params.id } });
  if (!dep) return res.status(404).json({ error: "NOT_FOUND" });
  if (dep.confirmed) return res.json(dep);
  const updated = await prisma.customerDeposit.update({ where: { id: dep.id }, data: { confirmed: true, confirmedBy: req.user!.id, confirmedAt: new Date() } });
  if (dep.walletId) {
    await prisma.wallet.update({ where: { id: dep.walletId }, data: { balance: { increment: Number(dep.amountVnd) } } });
    await prisma.walletTxn.create({ data: { id: uuid(), walletId: dep.walletId, amount: Number(dep.amountVnd), type: "customer_deposit" } });
  }
  await logAudit({ actorId: req.user!.id, targetId: dep.customerId, action: "customer.deposit_confirmed", metadata: { amountVnd: Number(dep.amountVnd) } });
  void syncCustomerOrders(dep.customerId);
  res.json(updated);
});

// Hủy xác nhận (bấm nhầm): rút ví ra, về trạng thái chờ
accountingRouter.post("/customer-deposits/:id/unconfirm", authorize("accounting.reconcile"), async (req, res) => {
  const dep = await prisma.customerDeposit.findUnique({ where: { id: req.params.id } });
  if (!dep) return res.status(404).json({ error: "NOT_FOUND" });
  if (!dep.confirmed) return res.json(dep);
  const updated = await prisma.customerDeposit.update({ where: { id: dep.id }, data: { confirmed: false, confirmedBy: null, confirmedAt: null } });
  if (dep.walletId) await prisma.wallet.update({ where: { id: dep.walletId }, data: { balance: { decrement: Number(dep.amountVnd) } } });
  await logAudit({ actorId: req.user!.id, targetId: dep.customerId, action: "customer.deposit_unconfirmed" });
  void syncCustomerOrders(dep.customerId);
  res.json(updated);
});

// Danh sách cọc CHỜ xác nhận (kế toán check tối) - kèm tên khách
accountingRouter.get("/deposits/pending", authorize("accounting.reconcile"), async (_req, res) => {
  const rows = await prisma.customerDeposit.findMany({ where: { confirmed: false }, orderBy: { createdAt: "desc" }, take: 300 });
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const customers = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } });
  const map = new Map(customers.map((c) => [c.id, c]));
  res.json(rows.map((r) => ({ ...r, customerName: map.get(r.customerId)?.name ?? "?", customerCode: map.get(r.customerId)?.code ?? null })));
});

accountingRouter.delete("/customer-deposits/:id", authorize("accounting.record_payment"), async (req, res) => {
  const dep = await prisma.customerDeposit.findUnique({ where: { id: req.params.id } });
  if (!dep) return res.status(404).json({ error: "NOT_FOUND" });
  if (dep.confirmed && dep.walletId) await prisma.wallet.update({ where: { id: dep.walletId }, data: { balance: { decrement: Number(dep.amountVnd) } } });
  await prisma.customerDeposit.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: dep.customerId, action: "customer.deposit_deleted" });
  if (dep.confirmed) void syncCustomerOrders(dep.customerId);
  res.json({ ok: true });
});

accountingRouter.get("/wallets", authorize("accounting.reconcile"), async (_req, res) => {
  const wallets = await prisma.wallet.findMany({ orderBy: { name: "asc" } });
  res.json(wallets);
});

// ===== Quỹ tổng (JPY) =====
async function getFund() {
  return prisma.fund.upsert({ where: { id: "main" }, update: {}, create: { id: "main", balance: 0 } });
}

accountingRouter.get("/fund", authorize("accounting.reconcile"), async (_req, res) => {
  const fund = await getFund();
  const txns = await prisma.fundTxn.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  res.json({ balance: Number(fund.balance), txns });
});

const topupSchema = z.object({ amountYen: z.number().positive(), rate: z.number().positive().optional(), note: z.string().optional() });
accountingRouter.post("/fund/topup", authorize("wallets.manage"), async (req, res) => {
  const p = topupSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await getFund();
  const fund = await prisma.fund.update({ where: { id: "main" }, data: { balance: { increment: p.data.amountYen } } });
  await prisma.fundTxn.create({ data: { id: uuid(), type: "topup", amountYen: p.data.amountYen, rate: p.data.rate ?? null, note: p.data.note ?? null } });
  await logAudit({ actorId: req.user!.id, action: "fund.topup", metadata: { amountYen: p.data.amountYen, rate: p.data.rate } });
  res.json({ balance: Number(fund.balance) });
});

const setSchema = z.object({ amountYen: z.number().nonnegative(), note: z.string().optional() });
accountingRouter.post("/fund/set", authorize("wallets.manage"), async (req, res) => {
  const p = setSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await getFund();
  const fund = await prisma.fund.update({ where: { id: "main" }, data: { balance: p.data.amountYen } });
  await prisma.fundTxn.create({ data: { id: uuid(), type: "set", amountYen: p.data.amountYen, note: p.data.note ?? "Đặt số dư" } });
  await logAudit({ actorId: req.user!.id, action: "fund.set", metadata: { amountYen: p.data.amountYen } });
  res.json({ balance: Number(fund.balance) });
});

const allocSchema = z.object({ walletId: z.string().uuid(), amountYen: z.number().positive(), note: z.string().optional() });
accountingRouter.post("/fund/allocate", authorize("wallets.manage"), async (req, res) => {
  const p = allocSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const wallet = await prisma.wallet.findUnique({ where: { id: p.data.walletId } });
  if (!wallet) return res.status(404).json({ error: "WALLET_NOT_FOUND" });
  await getFund();
  const fund = await prisma.fund.update({ where: { id: "main" }, data: { balance: { decrement: p.data.amountYen } } });
  await prisma.wallet.update({ where: { id: p.data.walletId }, data: { balance: { increment: p.data.amountYen } } });
  await prisma.walletTxn.create({ data: { id: uuid(), walletId: p.data.walletId, amount: p.data.amountYen, type: "fund_allocate" } });
  await prisma.fundTxn.create({ data: { id: uuid(), type: "allocate", amountYen: p.data.amountYen, walletId: p.data.walletId, note: p.data.note ?? null } });
  await logAudit({ actorId: req.user!.id, targetId: p.data.walletId, action: "fund.allocate", metadata: { amountYen: p.data.amountYen } });
  res.json({ balance: Number(fund.balance) });
});

// Cashback (tiền mua hàng được hoàn, JPY) -> cộng vào 1 thẻ, tách riêng để báo cáo
const cashbackSchema = z.object({ walletId: z.string().uuid(), amountYen: z.number().positive(), note: z.string().optional() });
accountingRouter.post("/cashback", authorize("wallets.manage"), async (req, res) => {
  const p = cashbackSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const wallet = await prisma.wallet.findUnique({ where: { id: p.data.walletId } });
  if (!wallet) return res.status(404).json({ error: "WALLET_NOT_FOUND" });
  const updated = await prisma.wallet.update({ where: { id: p.data.walletId }, data: { balance: { increment: p.data.amountYen } } });
  await prisma.walletTxn.create({ data: { id: uuid(), walletId: p.data.walletId, amount: p.data.amountYen, type: "cashback", statementRef: p.data.note || null } });
  await prisma.fundTxn.create({ data: { id: uuid(), type: "cashback", amountYen: p.data.amountYen, walletId: p.data.walletId, note: p.data.note ?? null } });
  await logAudit({ actorId: req.user!.id, targetId: p.data.walletId, action: "wallet.cashback", metadata: { amountYen: p.data.amountYen } });
  res.json({ balance: Number(updated.balance) });
});

const walletSchema = z.object({ name: z.string().min(1), currency: z.string().default("VND"), balance: z.number().optional() });
accountingRouter.post("/wallets", authorize("wallets.manage"), async (req, res) => {
  const p = walletSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (await prisma.wallet.findUnique({ where: { name: p.data.name } })) return res.status(409).json({ error: "WALLET_EXISTS" });
  const w = await prisma.wallet.create({ data: { id: uuid(), name: p.data.name, currency: p.data.currency, balance: p.data.balance ?? 0 } });
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

// Sao kê 1 ví: số dư lũy kế (残高) + lọc theo ngày / khách / tracking / từ khóa
accountingRouter.get("/statement", authorize("accounting.reconcile"), async (req, res) => {
  const walletId = typeof req.query.walletId === "string" ? req.query.walletId : null;
  if (!walletId) return res.json({ rows: [], balance: 0 });

  const from = req.query.from ? new Date(String(req.query.from)) : null;
  const to = req.query.to ? new Date(String(req.query.to)) : null;
  if (to) to.setHours(23, 59, 59, 999);
  const customerQ = String(req.query.customer ?? "").trim().toLowerCase();
  const trackingQ = String(req.query.tracking ?? "").trim().toLowerCase();
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const onlyPending = req.query.onlyPending === "true";

  const txns = await prisma.walletTxn.findMany({ where: { walletId }, orderBy: { createdAt: "asc" } });

  const orderIds = [...new Set(txns.map((t) => t.refOrderId).filter(Boolean))] as string[];
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, code: true, customer: { select: { name: true, phone: true } }, trackings: { select: { code: true, vnTrackingCode: true } } },
      })
    : [];
  const omap = new Map(orders.map((o) => [o.id, o]));

  let bal = 0;
  const enriched = txns.map((t) => {
    bal += Number(t.amount);
    const o = t.refOrderId ? omap.get(t.refOrderId) : undefined;
    const trackings = (o?.trackings.flatMap((tr) => [tr.code, tr.vnTrackingCode]) ?? []).filter((x): x is string => !!x);
    return {
      id: t.id,
      date: t.createdAt,
      amount: Number(t.amount),
      type: t.type,
      reconciled: t.reconciled,
      statementRef: t.statementRef,
      orderCode: o?.code ?? null,
      customer: o?.customer?.name ?? null,
      phone: o?.customer?.phone ?? null,
      trackings,
      balance: bal,
    };
  });

  let rows = enriched;
  if (from) rows = rows.filter((r) => r.date >= from);
  if (to) rows = rows.filter((r) => r.date <= to);
  if (customerQ) rows = rows.filter((r) => (r.customer ?? "").toLowerCase().includes(customerQ));
  if (trackingQ) rows = rows.filter((r) => r.trackings.some((c) => c.toLowerCase().includes(trackingQ)));
  if (q) rows = rows.filter((r) => [r.orderCode, r.customer, r.type, ...r.trackings].some((x) => (x ?? "").toLowerCase().includes(q)));
  if (onlyPending) rows = rows.filter((r) => !r.reconciled);

  rows.reverse();
  res.json({ rows, balance: bal });
});

const reconcileSchema = z.object({ statementRef: z.string().optional() });
accountingRouter.post("/wallet-txns/:id/reconcile", authorize("accounting.reconcile"), async (req, res) => {
  const p = reconcileSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const txn = await prisma.walletTxn.update({ where: { id: req.params.id }, data: { reconciled: true, statementRef: p.data.statementRef } });
  await logAudit({ actorId: req.user!.id, targetId: txn.id, action: "wallet_txn.reconciled" });
  res.json(txn);
});
