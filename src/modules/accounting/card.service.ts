import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { writeAudit, type Actor } from "./accounting.repository.js";
import { recordFundTxn } from "./fund.service.js";
import { deleteWalletTxnsById, postWalletTxn } from "./wallet.service.js";

// ===== Sổ giao dịch thẻ: Thu/Chi tự cộng/trừ số dư =====
// Chi (out) trừ thẻ, Thu (in) cộng thẻ. Chuyển khoản/Nhập tiền dùng endpoint transfer riêng.
export const TXN_CATEGORIES: Record<string, "in" | "out"> = {
  "Mua hàng": "out",
  "Hoàn tiền": "in",
  "Nạp tiền": "in",
  "Thu khác": "in",
  "Phí dịch vụ": "out",
  "Phí nạp tiền": "out",
  "Lỗi giao dịch": "out",
  "Chi khác": "out",
};

export type CardTxnInput = { walletId: string; category: string; amount: number; note?: string; date?: Date; refOrderId?: string };

export async function recordCardTxn(input: CardTxnInput, actor: Actor) {
  const dir = TXN_CATEGORIES[input.category];
  if (!dir) throw new LegacyError(400, "BAD_CATEGORY", "Loại giao dịch không hợp lệ");
  const signed = dir === "out" ? -input.amount : input.amount;
  const { txn, wallet } = await prisma.$transaction(async (tx) => {
    const w = await tx.wallet.findUnique({ where: { id: input.walletId } });
    if (!w) throw new LegacyError(404, "WALLET_NOT_FOUND");
    const r = await postWalletTxn(tx, {
      walletId: w.id, amount: signed, type: input.category, category: input.category,
      note: input.note ?? null, refOrderId: input.refOrderId ?? null, createdAt: input.date ?? new Date(),
    });
    await writeAudit(tx, { actorId: actor.id, targetId: w.id, action: "wallet.txn", requestId: actor.requestId, metadata: { category: input.category, amount: signed } });
    return r;
  });
  eventBus.publish({ eventName: "wallet.transaction_created", actorId: actor.id, entityType: "wallet_txn", entityId: txn.id, metadata: { walletId: wallet.id, category: input.category, amount: signed } });
  return { txn, balance: Number(wallet.balance) };
}

export type TransferInput = { fromWalletId: string; toWalletId: string; amount: number; fee?: number; note?: string; date?: Date };

// Chuyển tiền giữa 2 thẻ: 1 lần ghi -> thẻ nguồn trừ, thẻ đích cộng (+ phí nếu có), cùng 1 transaction.
export async function transfer(input: TransferInput, actor: Actor) {
  if (input.fromWalletId === input.toWalletId) throw new LegacyError(400, "SAME_WALLET", "Thẻ nguồn và đích phải khác nhau");
  const ref = uuid();
  const at = input.date ?? new Date();
  await prisma.$transaction(async (tx) => {
    const [from, to] = await Promise.all([
      tx.wallet.findUnique({ where: { id: input.fromWalletId } }),
      tx.wallet.findUnique({ where: { id: input.toWalletId } }),
    ]);
    if (!from || !to) throw new LegacyError(404, "WALLET_NOT_FOUND");
    if (from.currency !== to.currency) throw new LegacyError(400, "CURRENCY_MISMATCH", "Hai thẻ khác đơn vị tiền, không chuyển trực tiếp được");
    await postWalletTxn(tx, { walletId: from.id, amount: -input.amount, type: "Chuyển khoản", category: "Chuyển khoản", note: input.note ?? `Chuyển sang ${to.name}`, transferRef: ref, createdAt: at });
    await postWalletTxn(tx, { walletId: to.id, amount: input.amount, type: "Nhập tiền", category: "Nhập tiền", note: input.note ?? `Nhận từ ${from.name}`, transferRef: ref, createdAt: at });
    // Phí chuyển (nếu có) -> trừ thêm thẻ nguồn, cùng nhóm transferRef để xóa hoàn cả cụm
    if (input.fee && input.fee > 0) {
      await postWalletTxn(tx, { walletId: from.id, amount: -input.fee, type: "Phí dịch vụ", category: "Phí dịch vụ", note: `Phí chuyển sang ${to.name}`, transferRef: ref, createdAt: at });
    }
    await writeAudit(tx, { actorId: actor.id, action: "wallet.transfer", requestId: actor.requestId, metadata: { from: from.name, to: to.name, amount: input.amount, fee: input.fee ?? 0 } });
  });
  eventBus.publish({ eventName: "wallet.transfer_completed", actorId: actor.id, entityType: "wallet_transfer", entityId: ref, metadata: { fromWalletId: input.fromWalletId, toWalletId: input.toWalletId, amount: input.amount, fee: input.fee ?? 0 } });
}

// Xóa 1 giao dịch thẻ (hoàn lại số dư). Nếu là chuyển khoản thì hoàn cả cụm (2 vế + phí).
export async function deleteCardTxn(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const txn = await tx.walletTxn.findUnique({ where: { id } });
    if (!txn) throw new LegacyError(404, "NOT_FOUND");
    const group = txn.transferRef ? await tx.walletTxn.findMany({ where: { transferRef: txn.transferRef } }) : [txn];
    await deleteWalletTxnsById(tx, group);
    await writeAudit(tx, { actorId: actor.id, targetId: txn.walletId, action: "wallet.txn_deleted", requestId: actor.requestId, metadata: { category: txn.category } });
  });
}

export async function reconcileTxn(id: string, statementRef: string | undefined, actor: Actor) {
  const txn = await prisma.walletTxn.update({ where: { id }, data: { reconciled: true, statementRef } });
  await logAudit({ actorId: actor.id, targetId: txn.id, action: "wallet_txn.reconciled", requestId: actor.requestId });
  return txn;
}

// Cashback (tiền mua hàng được hoàn, JPY) -> ghi CHỜ, xác nhận qua /fund/:id/confirm mới cộng thẻ.
export function recordCashback(input: { walletId: string; amountYen: number; note?: string }, actor: Actor) {
  return recordFundTxn(
    { type: "cashback", amountYen: input.amountYen, walletId: input.walletId, note: input.note ?? null },
    { action: "wallet.cashback_recorded", targetId: input.walletId, metadata: { amountYen: input.amountYen } },
    actor,
  );
}

// Sửa 1 lần: đơn Yahoo/Mercari thanh toán sau trước đây ghi sổ "Mua hàng" theo ngày bấm Đã thanh toán
// (bug đã fix ở route /pay) -> dồn sai ngày cho các đơn cũ, dù món hàng đã có đúng "Ngày mua" riêng.
// Chỉ tự sửa khi khớp đúng 1 món - 1 giao dịch (rõ ràng, không đoán); đơn nhiều món/nhiều giao dịch bỏ qua để tự kiểm tra tay.
// Chỉ đổi ngày dòng sổ, không đổi số dư.
export async function backfillYahooDates(actor: Actor) {
  const orders = await prisma.order.findMany({ where: { source: { in: ["yahoo", "mercari"] }, yahooPaidAt: { not: null } }, include: { items: true } });
  let updated = 0, skipped = 0;
  for (const o of orders) {
    const txns = await prisma.walletTxn.findMany({ where: { refOrderId: o.id, category: "Mua hàng" } });
    if (txns.length !== 1 || o.items.length !== 1) { skipped++; continue; }
    const target = o.items[0].purchaseDate ?? o.orderDate;
    const t = txns[0];
    if (t.createdAt.toISOString().slice(0, 10) !== target.toISOString().slice(0, 10)) {
      await prisma.walletTxn.update({ where: { id: t.id }, data: { createdAt: target } });
      updated++;
    }
  }
  await logAudit({ actorId: actor.id, action: "accounting.backfill_yahoo_dates", metadata: { updated, skipped }, requestId: actor.requestId });
  return { updated, skipped, totalPaidOrders: orders.length };
}
