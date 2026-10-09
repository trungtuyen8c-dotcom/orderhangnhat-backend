// Report accounting_* - copy logic từ accounting.routes.ts (đọc-only, không import file đó).
import { prisma } from "../../../infrastructure/prisma.js";
import { vnDayStart, vnMonthKey } from "../helpers.js";

import { vnDayEnd } from "../../../app/vnTime.js";
import * as reports from "../../accounting/report.service.js";
import { walletLedger } from "../../accounting/wallet.service.js";
const OPENING_CUTOFF = new Date("2026-06-30T00:00:00.000Z");
void OPENING_CUTOFF; // giữ tham chiếu comment gốc - opening balance nhận diện qua isOpening, không cần lọc theo mốc này ở đây

// Cùng công thức nợ với /accounting/debts (tổng đơn - cọc đã xác nhận - thanh toán).
export async function accounting_debts() {
  return (await reports.debtsByCustomer()).map(({ customerId, name, phone, balance, balanceJpy, updatedAt }) => ({ customerId, name, phone, balance, balanceJpy, updatedAt }));
}

export async function accounting_deposits(params: { status?: string; from?: string; to?: string }) {
  const where: Record<string, unknown> = { isOpening: false };
  if (params.status === "pending") where.confirmed = false;
  else if (params.status === "confirmed") where.confirmed = true;
  else if (params.status === "fix_request") where.fixRequest = { not: null };
  if (params.from || params.to) where.paidAt = { ...(params.from ? { gte: vnDayStart(params.from) } : {}), ...(params.to ? { lte: vnDayEnd(params.to) } : {}) };

  const rows = await prisma.customerDeposit.findMany({ where, orderBy: { paidAt: "desc" }, take: 500 });
  const custIds = [...new Set(rows.map((r) => r.customerId))];
  const userIds = [...new Set([...rows.map((r) => r.recordedBy), ...rows.map((r) => r.confirmedBy)].filter((x): x is string => !!x))];
  const [customers, users] = await Promise.all([
    custIds.length ? prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true, code: true } }) : Promise.resolve([]),
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }) : Promise.resolve([]),
  ]);
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const umap = new Map(users.map((u) => [u.id, u.fullName || u.email]));
  return rows.map((r) => ({
    id: r.id, customerId: r.customerId, customerName: cmap.get(r.customerId)?.name ?? null, customerCode: cmap.get(r.customerId)?.code ?? null,
    amountVnd: Number(r.amountVnd), currency: r.currency, amountOrig: Number(r.amountOrig), exchangeRate: r.exchangeRate ? Number(r.exchangeRate) : null,
    payerName: r.payerName, method: r.method, note: r.note, paidAt: r.paidAt, confirmed: r.confirmed,
    recordedByName: r.recordedBy ? umap.get(r.recordedBy) ?? null : null, confirmedByName: r.confirmedBy ? umap.get(r.confirmedBy) ?? null : null,
    fixRequest: r.fixRequest, fixRequestedAt: r.fixRequestedAt,
  }));
}

export async function accounting_deposits_counts() {
  const [pending, confirmed, fixRequest, all] = await Promise.all([
    prisma.customerDeposit.count({ where: { confirmed: false, isOpening: false } }),
    prisma.customerDeposit.count({ where: { confirmed: true, isOpening: false } }),
    prisma.customerDeposit.count({ where: { fixRequest: { not: null } } }),
    prisma.customerDeposit.count({ where: { isOpening: false } }),
  ]);
  return { pending, confirmed, fixRequest, all };
}

export async function accounting_opening_balances() {
  const rows = await prisma.customerDeposit.findMany({ where: { isOpening: true } });
  return rows.map((r) => ({ customerId: r.customerId, amountOrig: Number(r.amountOrig), currency: r.currency, exchangeRate: r.exchangeRate != null ? Number(r.exchangeRate) : null, amountVnd: Number(r.amountVnd) }));
}

// Dùng lại đúng báo cáo của trang Kế toán (1 công thức công nợ, ₫ + ¥) - không copy logic riêng cho MCP.
export const accounting_customer_summary = () => reports.customerSummary();

export async function accounting_monthly_report(params: { month?: string }) {
  return reports.monthlyReport(params.month);
}

// Sổ giao dịch thẻ (gộp với dự án khác dùng chung thẻ). from/to = YYYY-MM-DD giờ VN, wallet = tên thẻ.
export function accounting_wallet_ledger(params: { from?: string; to?: string; wallet?: string }) {
  return walletLedger({
    from: params.from ? vnDayStart(params.from) : undefined,
    to: params.to ? vnDayEnd(params.to) : undefined,
    wallet: params.wallet || undefined,
  });
}

export function accounting_wallets() {
  return prisma.wallet.findMany({ orderBy: { name: "asc" } });
}

export async function accounting_fund(params: { status?: string }) {
  const fund = await prisma.fund.findUnique({ where: { id: "main" } });
  const where = params.status === "pending" ? { confirmed: false, fixRequest: null }
    : params.status === "confirmed" ? { confirmed: true }
    : params.status === "fix_request" ? { fixRequest: { not: null } }
    : {};
  const txns = await prisma.fundTxn.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  const uids = [...new Set([...txns.map((t) => t.recordedBy), ...txns.map((t) => t.confirmedBy)].filter((x): x is string => !!x))];
  const users = uids.length ? await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, fullName: true, email: true } }) : [];
  const umap = new Map(users.map((u) => [u.id, u.fullName || u.email]));
  return {
    balance: Number(fund?.balance ?? 0),
    txns: txns.map((t) => ({
      id: t.id, type: t.type, amountYen: Number(t.amountYen), rate: t.rate ? Number(t.rate) : null, walletId: t.walletId, note: t.note,
      createdAt: t.createdAt, confirmed: t.confirmed, confirmedAt: t.confirmedAt, fixRequest: t.fixRequest, fixRequestedAt: t.fixRequestedAt,
      recordedByName: t.recordedBy ? umap.get(t.recordedBy) ?? null : null, confirmedByName: t.confirmedBy ? umap.get(t.confirmedBy) ?? null : null,
    })),
  };
}

export async function accounting_fund_counts() {
  const [pending, confirmed, fixRequest, all] = await Promise.all([
    prisma.fundTxn.count({ where: { confirmed: false, fixRequest: null } }),
    prisma.fundTxn.count({ where: { confirmed: true } }),
    prisma.fundTxn.count({ where: { fixRequest: { not: null } } }),
    prisma.fundTxn.count(),
  ]);
  return { pending, confirmed, fixRequest, all };
}

export function accounting_reconcile() {
  return prisma.walletTxn.findMany({ where: { reconciled: false }, orderBy: { createdAt: "desc" }, take: 300, include: { wallet: { select: { name: true } } } });
}

export async function accounting_statement(params: { walletId?: string; from?: string; to?: string; customer?: string; tracking?: string; q?: string; onlyPending?: string }) {
  if (!params.walletId) return { rows: [], balance: 0 };
  const txns = await prisma.walletTxn.findMany({ where: { walletId: params.walletId }, orderBy: { createdAt: "asc" } });
  const orderIds = [...new Set(txns.map((t) => t.refOrderId).filter((x): x is string => !!x))];
  const depositIds = [...new Set(txns.map((t) => t.refDepositId).filter((x): x is string => !!x))];
  const [orders, deposits] = await Promise.all([
    orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true, fixRequest: true, customer: { select: { name: true, phone: true } }, trackings: { select: { code: true, vnTrackingCode: true } } } }) : Promise.resolve([]),
    depositIds.length ? prisma.customerDeposit.findMany({ where: { id: { in: depositIds } }, select: { id: true, customerId: true, fixRequest: true } }) : Promise.resolve([]),
  ]);
  const omap = new Map(orders.map((o) => [o.id, o]));
  const depCustIds = [...new Set(deposits.map((d) => d.customerId))];
  const depCustomers = depCustIds.length ? await prisma.customer.findMany({ where: { id: { in: depCustIds } }, select: { id: true, name: true, phone: true } }) : [];
  const dcmap = new Map(depCustomers.map((c) => [c.id, c]));
  const dmap = new Map(deposits.map((d) => [d.id, { ...d, customer: dcmap.get(d.customerId) }]));

  let bal = 0;
  const enriched = txns.map((t) => {
    bal += Number(t.amount);
    const o = t.refOrderId ? omap.get(t.refOrderId) : undefined;
    const d = t.refDepositId ? dmap.get(t.refDepositId) : undefined;
    const trackings = (o?.trackings.flatMap((tr) => [tr.code, tr.vnTrackingCode]) ?? []).filter((x): x is string => !!x);
    return {
      id: t.id, date: t.createdAt, amount: Number(t.amount), type: t.type,
      category: t.category ?? t.type, note: t.note ?? t.statementRef, reconciled: t.reconciled,
      statementRef: t.statementRef, orderId: t.refOrderId ?? null, orderCode: o?.code ?? null,
      depositId: t.refDepositId ?? null, fixRequest: o?.fixRequest ?? d?.fixRequest ?? null,
      customer: o?.customer?.name ?? d?.customer?.name ?? null, phone: o?.customer?.phone ?? d?.customer?.phone ?? null,
      trackings, balance: bal,
    };
  });
  const from = params.from ? vnDayStart(params.from) : null;
  const to = params.to ? vnDayEnd(params.to) : null;
  const customerQ = (params.customer ?? "").trim().toLowerCase();
  const trackingQ = (params.tracking ?? "").trim().toLowerCase();
  const q = (params.q ?? "").trim().toLowerCase();
  const onlyPending = params.onlyPending === "true";
  const filtered = enriched.filter((r) => {
    if (from && r.date < from) return false;
    if (to && r.date > to) return false;
    if (onlyPending && r.reconciled) return false;
    if (customerQ && !(r.customer ?? "").toLowerCase().includes(customerQ)) return false;
    if (trackingQ && !r.trackings.some((t) => t.toLowerCase().includes(trackingQ))) return false;
    if (q && ![r.orderCode, r.customer, r.type, ...r.trackings].some((v) => (v ?? "").toString().toLowerCase().includes(q))) return false;
    return true;
  });
  return { rows: filtered.reverse(), balance: bal };
}
