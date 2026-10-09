import { v4 as uuid } from "uuid";
import { depositCreditsJpy } from "../customers/customerBalance.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { vnDayEnd, vnDayStart } from "../../app/vnTime.js";
import { queueAccountingSheetSync } from "../sheets/sheet.jobs.js";
import { lockCustomer, lockDeposit, writeAudit, type Actor } from "./accounting.repository.js";
import { adjustDepositWalletTxn, postWalletTxn, reverseWalletTxns } from "./wallet.service.js";

const notFound = () => new AppError("NOT_FOUND", 404);

export type DepositInput = {
  amount: number;
  currency: "VND" | "JPY";
  exchangeRate?: number;
  payerName?: string;
  method?: string;
  walletId?: string;
  note?: string;
  paidAt?: Date;
};

// NV ghi cọc -> trạng thái CHỜ (chưa cộng ví, chưa trừ nợ). Kế toán xác nhận sau.
export async function createDeposit(customerId: string, input: DepositInput, actor: Actor) {
  const dep = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw notFound();
    if (input.currency === "JPY" && !input.exchangeRate) throw new AppError("BAD_REQUEST", 400, "Cọc JPY cần nhập tỉ giá");
    const amountVnd = input.currency === "JPY" ? Math.round(input.amount * input.exchangeRate!) : input.amount;
    if (input.walletId) {
      const w = await tx.wallet.findUnique({ where: { id: input.walletId } });
      if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
      if (w.currency !== "VND") throw new AppError("CURRENCY_MISMATCH", 400, "Cọc khách phải vào ví VND");
    }
    const d = await tx.customerDeposit.create({
      data: { id: uuid(), customerId, amountVnd, currency: input.currency, amountOrig: input.amount, exchangeRate: input.exchangeRate ?? null, payerName: input.payerName || null, method: input.method || null, walletId: input.walletId || null, note: input.note || null, paidAt: input.paidAt ?? new Date(), recordedBy: actor.id },
    });
    await writeAudit(tx, { actorId: actor.id, targetId: customerId, action: "customer.deposit", requestId: actor.requestId, metadata: { amountVnd, currency: input.currency, confirmed: false } });
    return d;
  });
  void queueAccountingSheetSync(customerId);
  eventBus.publish({ eventName: "deposit.created", actorId: actor.id, entityType: "customer_deposit", entityId: dep.id, metadata: { customerId, amountVnd: Number(dep.amountVnd) } });
  return dep;
}

// Kế toán bấm tích: tiền thật đã vào -> cộng ví + trừ nợ. Bấm lại / bấm đồng thời -> không cộng lần 2.
export async function confirmDeposit(id: string, actor: Actor) {
  const { dep, changed } = await prisma.$transaction(async (tx) => {
    const cur = await lockDeposit(tx, id);
    if (!cur) throw notFound();
    if (cur.confirmed) return { dep: cur, changed: false };
    const updated = await tx.customerDeposit.update({ where: { id: cur.id }, data: { confirmed: true, confirmedBy: actor.id, confirmedAt: new Date() } });
    if (cur.walletId) {
      await postWalletTxn(tx, { walletId: cur.walletId, amount: Number(cur.amountVnd), type: "customer_deposit", category: "Cọc khách", note: cur.payerName ?? null, refDepositId: cur.id });
    }
    await writeAudit(tx, { actorId: actor.id, targetId: cur.customerId, action: "customer.deposit_confirmed", requestId: actor.requestId, metadata: { amountVnd: Number(cur.amountVnd) } });
    return { dep: updated, changed: true };
  });
  if (changed) {
    void queueAccountingSheetSync(dep.customerId);
    eventBus.publish({ eventName: "deposit.confirmed", actorId: actor.id, entityType: "customer_deposit", entityId: dep.id, metadata: { customerId: dep.customerId, amountVnd: Number(dep.amountVnd), walletId: dep.walletId } });
  }
  return dep;
}

// Hủy xác nhận (bấm nhầm): rút ví ra, về trạng thái chờ
export async function unconfirmDeposit(id: string, actor: Actor) {
  const { dep, changed } = await prisma.$transaction(async (tx) => {
    const cur = await lockDeposit(tx, id);
    if (!cur) throw notFound();
    if (!cur.confirmed) return { dep: cur, changed: false };
    const updated = await tx.customerDeposit.update({ where: { id: cur.id }, data: { confirmed: false, confirmedBy: null, confirmedAt: null } });
    // Xóa đúng giao dịch ví đã tạo lúc xác nhận (không chỉ trừ số dư) -> tránh sổ ví còn dòng "ma" không khớp số dư.
    await reverseWalletTxns(tx, { refDepositId: cur.id });
    await writeAudit(tx, { actorId: actor.id, targetId: cur.customerId, action: "customer.deposit_unconfirmed", requestId: actor.requestId });
    return { dep: updated, changed: true };
  });
  if (changed) void queueAccountingSheetSync(dep.customerId);
  return dep;
}

export type DepositEditInput = {
  payerName?: string;
  amount?: number;
  currency?: "VND" | "JPY";
  exchangeRate?: number;
  method?: string;
  note?: string;
  paidAt?: Date;
};

// Sửa cọc đã ghi. Nếu cọc đã xác nhận (tiền đã vào ví) mà đổi số tiền -> chỉnh đúng chênh lệch trên ví
// + giao dịch ví liên kết, cùng transaction.
export async function editDeposit(id: string, input: DepositEditInput, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const dep = await lockDeposit(tx, id);
    if (!dep) throw notFound();
    const data: Record<string, unknown> = {};
    if (input.payerName !== undefined) data.payerName = input.payerName || null;
    if (input.method !== undefined) data.method = input.method || null;
    if (input.note !== undefined) data.note = input.note || null;
    if (input.paidAt !== undefined) data.paidAt = input.paidAt;
    let newAmountVnd = Number(dep.amountVnd);
    if (input.amount !== undefined || input.currency !== undefined || input.exchangeRate !== undefined) {
      const currency = input.currency ?? dep.currency ?? "VND";
      const amount = input.amount ?? Number(dep.amountOrig);
      const exchangeRate = input.exchangeRate ?? (dep.exchangeRate != null ? Number(dep.exchangeRate) : undefined);
      if (currency === "JPY" && !exchangeRate) throw new AppError("BAD_REQUEST", 400, "Cọc JPY cần nhập tỉ giá");
      newAmountVnd = currency === "JPY" ? Math.round(amount * exchangeRate!) : amount;
      data.currency = currency; data.amountOrig = amount; data.exchangeRate = exchangeRate ?? null; data.amountVnd = newAmountVnd;
    }
    const updated = await tx.customerDeposit.update({ where: { id: dep.id }, data });
    if (dep.confirmed && dep.walletId && newAmountVnd !== Number(dep.amountVnd)) {
      await adjustDepositWalletTxn(tx, dep.walletId, dep.id, newAmountVnd - Number(dep.amountVnd), newAmountVnd);
    }
    await writeAudit(tx, { actorId: actor.id, targetId: dep.id, action: "customer_deposit.updated", requestId: actor.requestId, metadata: input });
    return updated;
  });
}

export async function deleteDeposit(id: string, actor: Actor) {
  const dep = await prisma.$transaction(async (tx) => {
    const cur = await lockDeposit(tx, id);
    if (!cur) throw notFound();
    await reverseWalletTxns(tx, { refDepositId: cur.id });
    await tx.customerDeposit.delete({ where: { id: cur.id } });
    await writeAudit(tx, { actorId: actor.id, targetId: cur.customerId, action: "customer.deposit_deleted", requestId: actor.requestId });
    return cur;
  });
  void queueAccountingSheetSync(dep.customerId);
  eventBus.publish({ eventName: "deposit.deleted", actorId: actor.id, entityType: "customer_deposit", entityId: dep.id, metadata: { customerId: dep.customerId, amountVnd: Number(dep.amountVnd), confirmed: dep.confirmed } });
}

// ---- Danh sách / yêu cầu sửa (không động tiền) ----

export async function listDeposits(q: { status?: string; from?: string; to?: string }) {
  const status = q.status ?? "pending";
  const from = q.from ? vnDayStart(q.from) : null;
  const to = q.to ? vnDayEnd(q.to) : null;
  const where: any = { isOpening: false };
  if (status === "pending") where.confirmed = false;
  else if (status === "confirmed") where.confirmed = true;
  else if (status === "fix_request") where.fixRequest = { not: null };
  if (from || to) where.paidAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };

  const rows = await prisma.customerDeposit.findMany({ where, orderBy: { paidAt: "desc" }, take: 500 });
  const custIds = [...new Set(rows.map((r) => r.customerId))];
  const userIds = [...new Set(rows.flatMap((r) => [r.recordedBy, r.confirmedBy]).filter(Boolean))] as string[];
  const [customers, users] = await Promise.all([
    prisma.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, name: true, code: true } }),
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, email: true } }),
  ]);
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const umap = new Map(users.map((u) => [u.id, u]));
  const uname = (id: string | null) => (id ? umap.get(id)?.fullName ?? umap.get(id)?.email ?? null : null);
  return rows.map((r) => ({
    ...r,
    customerName: cmap.get(r.customerId)?.name ?? "?",
    customerCode: cmap.get(r.customerId)?.code ?? null,
    recordedByName: uname(r.recordedBy),
    confirmedByName: uname(r.confirmedBy),
  }));
}

export async function depositCounts() {
  const [pending, confirmed, fixRequest, all] = await Promise.all([
    prisma.customerDeposit.count({ where: { confirmed: false, isOpening: false } }),
    prisma.customerDeposit.count({ where: { confirmed: true, isOpening: false } }),
    prisma.customerDeposit.count({ where: { fixRequest: { not: null } } }),
    prisma.customerDeposit.count({ where: { isOpening: false } }),
  ]);
  return { pending, confirmed, fixRequest, all };
}

export async function requestDepositFix(id: string, note: string, actor: Actor) {
  const dep = await prisma.customerDeposit.findUnique({ where: { id } });
  if (!dep) throw notFound();
  await prisma.customerDeposit.update({ where: { id: dep.id }, data: { fixRequest: note, fixRequestedAt: new Date() } });
  await logAudit({ actorId: actor.id, targetId: dep.id, action: "customer_deposit.fix_requested", metadata: { note }, requestId: actor.requestId });
}

export async function resolveDepositFix(id: string, actor: Actor) {
  const dep = await prisma.customerDeposit.findUnique({ where: { id } });
  if (!dep) throw notFound();
  await prisma.customerDeposit.update({ where: { id: dep.id }, data: { fixRequest: null, fixRequestedAt: null } });
  await logAudit({ actorId: actor.id, targetId: dep.id, action: "customer_deposit.fix_resolved", requestId: actor.requestId });
}

export async function depositFixRequests() {
  const rows = await prisma.customerDeposit.findMany({
    where: { fixRequest: { not: null } }, orderBy: { fixRequestedAt: "desc" }, take: 50,
  });
  const ids = [...new Set(rows.map((r) => r.customerId))];
  const customers = await prisma.customer.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const cmap = new Map(customers.map((c) => [c.id, c]));
  return rows.map((r) => ({ id: r.id, fixRequest: r.fixRequest, customer: cmap.get(r.customerId)?.name ?? "?" }));
}

// ===== Số dư đầu kỳ: 1 bản ghi/khách/loại tiền, dương = khách dư tiền, âm = khách nợ. Không vào ví công ty. =====
// Khách trả yên có thể có 2 dòng: đầu kỳ ¥ (tiền hàng) và đầu kỳ ₫ (tiền cân) - xem customerBalance.ts.
const OPENING_CUTOFF = new Date("2026-06-30T00:00:00.000Z");

export async function listOpeningBalances() {
  const rows = await prisma.customerDeposit.findMany({ where: { isOpening: true } });
  return rows.map((r) => ({ customerId: r.customerId, amountOrig: Number(r.amountOrig), currency: r.currency, exchangeRate: r.exchangeRate != null ? Number(r.exchangeRate) : null, amountVnd: Number(r.amountVnd) }));
}

export async function setOpeningBalance(
  customerId: string,
  input: { amount: number; currency: "VND" | "JPY"; exchangeRate?: number; note?: string; date?: Date },
  actor: Actor,
) {
  const dep = await prisma.$transaction(async (tx) => {
    // Khoá khách: 2 lần lưu đồng thời không tạo ra 2 dòng đầu kỳ.
    const customer = await lockCustomer(tx, customerId);
    if (!customer) throw notFound();
    // Khách trả yên: đầu kỳ ¥ trừ thẳng nợ ¥, không cần tỉ giá. Khách ₫ nhập ¥ thì phải có tỉ giá để quy ra nợ ₫.
    const jpyLedger = depositCreditsJpy(customer.payCurrency, input.currency);
    if (input.currency === "JPY" && !jpyLedger && !input.exchangeRate) throw new AppError("BAD_REQUEST", 400, "Đầu kỳ JPY cần nhập tỉ giá");
    const amountVnd = input.currency === "JPY" ? Math.round(input.amount * (input.exchangeRate ?? 0)) : input.amount;
    await tx.customerDeposit.deleteMany({ where: { customerId, isOpening: true, currency: input.currency } });
    let d = null;
    if (input.amount !== 0) {
      d = await tx.customerDeposit.create({
        data: {
          id: uuid(), customerId, amountVnd, currency: input.currency, amountOrig: input.amount,
          exchangeRate: input.exchangeRate ?? null, note: input.note || "Số dư đầu kỳ", paidAt: input.date ?? OPENING_CUTOFF,
          confirmed: true, confirmedAt: new Date(), confirmedBy: actor.id, isOpening: true, recordedBy: actor.id,
        },
      });
    }
    await writeAudit(tx, { actorId: actor.id, targetId: customerId, action: "customer.opening_balance", requestId: actor.requestId, metadata: { amountVnd } });
    return d;
  });
  void queueAccountingSheetSync(customerId);
  return dep ?? { cleared: true };
}
