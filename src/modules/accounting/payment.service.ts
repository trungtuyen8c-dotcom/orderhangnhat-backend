import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { computeDebtBalance } from "../orders/order.totals.js";
import { queueAccountingSheetSync } from "../sheets/sheet.jobs.js";
import { lockOrder, userHasPermission, writeAudit, type Actor } from "./accounting.repository.js";
import { postWalletTxn } from "./wallet.service.js";

type Db = Prisma.TransactionClient;

// Tính lại công nợ của 1 đơn. Truyền `tx` khi gọi trong transaction tiền để nợ commit cùng payment.
export async function recomputeDebt(orderId: string, db: Db = prisma) {
  const order = await db.order.findUnique({ where: { id: orderId }, include: { payments: true } });
  if (!order) return;
  const { balance, currency } = computeDebtBalance(order, order.payments);
  const existing = await db.debt.findFirst({ where: { orderId } });
  if (existing) await db.debt.update({ where: { id: existing.id }, data: { balance, currency } });
  else await db.debt.create({ data: { id: uuid(), orderId, customerId: order.customerId, balance, currency } });
}

export type PaymentInput = {
  type: "deposit" | "final" | "refund";
  amount: number;
  currency: "VND" | "JPY";
  exchangeRate?: number;
  method?: string;
  walletId?: string;
};

const PRIVILEGED = ["super_admin", "admin", "accountant"];

// Ghi cọc / thu nốt / hoàn -> payment + cọc đơn + ví + công nợ + audit trong 1 transaction.
export async function recordPayment(orderId: string, input: PaymentInput, actor: Actor) {
  const result = await prisma.$transaction(async (tx) => {
    // Khoá đơn: các payment đồng thời của cùng đơn chạy lần lượt -> công nợ tính lại không bị lệch.
    const order = await lockOrder(tx, orderId);
    if (!order) throw new AppError("NOT_FOUND", 404);
    if (input.type === "refund" && !(actor.roles ?? []).some((r) => PRIVILEGED.includes(r))) {
      if (!(await userHasPermission(tx, actor.id, "accounting.refund"))) throw new AppError("FORBIDDEN", 403, "Thiếu quyền accounting.refund");
    }

    // Quy đổi sang VND để tính công nợ (công nợ luôn theo VND)
    if (input.currency === "JPY" && !input.exchangeRate) throw new AppError("BAD_REQUEST", 400, "Thu JPY cần nhập tỉ giá");
    const amountVnd = input.currency === "JPY" ? Math.round(input.amount * input.exchangeRate!) : input.amount;

    // Ví phải cùng tiền tệ với khoản thu
    if (input.walletId) {
      const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
      if (!wallet) throw new AppError("WALLET_NOT_FOUND", 404);
      if (wallet.currency !== input.currency) throw new AppError("CURRENCY_MISMATCH", 400, `Ví ${wallet.name} là ${wallet.currency}, không nhận ${input.currency}`);
    }

    const payment = await tx.payment.create({
      data: {
        id: uuid(), orderId: order.id, type: input.type, amountVnd,
        currency: input.currency, amountOrig: input.amount, exchangeRate: input.exchangeRate ?? null,
        method: input.method || null, walletId: input.walletId || null, recordedBy: actor.id,
      },
    });

    if (input.type === "deposit") {
      await tx.order.update({ where: { id: order.id }, data: { deposit: { increment: amountVnd }, paidAt: order.paidAt ?? new Date() } });
    }

    if (input.walletId) {
      const sign = input.type === "refund" ? -1 : 1;
      // Ví ghi theo tiền tệ gốc của ví (đã kiểm tra trùng tiền tệ ở trên)
      await postWalletTxn(tx, { walletId: input.walletId, amount: sign * input.amount, type: input.type, refOrderId: order.id });
    }

    await recomputeDebt(order.id, tx);
    await writeAudit(tx, {
      actorId: actor.id, targetId: order.id, action: `payment.${input.type}`, requestId: actor.requestId,
      metadata: { amount: input.amount, currency: input.currency, amountVnd },
    });
    const debt = await tx.debt.findFirst({ where: { orderId: order.id } });
    return { payment, debt, customerId: order.customerId };
  });

  void queueAccountingSheetSync(result.customerId);
  eventBus.publish({
    eventName: input.type === "refund" ? "payment.refunded" : "payment.created",
    actorId: actor.id, entityType: "payment", entityId: result.payment.id,
    metadata: { orderId, type: input.type, amountVnd: Number(result.payment.amountVnd), walletId: input.walletId ?? null },
  });
  return { payment: result.payment, debt: result.debt };
}

export async function listOrderPayments(orderId: string) {
  const payments = await prisma.payment.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } });
  const debt = await prisma.debt.findFirst({ where: { orderId } });
  return { payments, debt };
}

// ===== Chi phí phát sinh / đền bù khách (không động công nợ, không động ví) =====
export type ExpenseInput = {
  orderId?: string;
  kind: "compensation" | "other";
  amount: number;
  currency: "VND" | "JPY";
  exchangeRate?: number;
  note?: string;
  incurredAt?: Date;
};

export async function createExpense(input: ExpenseInput, actor: Actor) {
  if (input.currency === "JPY" && !input.exchangeRate) throw new AppError("BAD_REQUEST", 400, "Nhập JPY cần tỉ giá");
  const amountVnd = input.currency === "JPY" ? Math.round(input.amount * input.exchangeRate!) : input.amount;
  const e = await prisma.expense.create({ data: {
    id: uuid(), orderId: input.orderId ?? null, kind: input.kind, amountVnd, currency: input.currency,
    amountOrig: input.amount, exchangeRate: input.exchangeRate ?? null, note: input.note ?? null,
    incurredAt: input.incurredAt ?? new Date(), recordedBy: actor.id,
  } });
  await logAudit({ actorId: actor.id, targetId: e.id, action: "expense.created", metadata: { kind: e.kind, amountVnd }, requestId: actor.requestId });
  return e;
}

export function listOrderExpenses(orderId: string) {
  return prisma.expense.findMany({ where: { orderId }, orderBy: { createdAt: "desc" } });
}

export async function deleteExpense(id: string, actor: Actor) {
  await prisma.expense.delete({ where: { id } });
  await logAudit({ actorId: actor.id, targetId: id, action: "expense.deleted", requestId: actor.requestId });
}
