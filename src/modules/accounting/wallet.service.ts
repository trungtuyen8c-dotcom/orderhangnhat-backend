import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { countWalletRefs, writeAudit, type Actor, type Tx } from "./accounting.repository.js";

// Nơi DUY NHẤT đổi Wallet.balance. Mọi hàm nhận `tx` -> caller bọc trong prisma.$transaction để
// số dư + dòng sổ WalletTxn luôn cùng commit hoặc cùng rollback. Cộng/trừ bằng increment/decrement
// (atomic ở DB), không đọc-sửa-ghi số dư.

function changeBalance(tx: Tx, walletId: string, delta: number) {
  return tx.wallet.update({
    where: { id: walletId },
    data: { balance: delta >= 0 ? { increment: delta } : { decrement: -delta } },
  });
}

export type WalletTxnInput = {
  walletId: string;
  amount: number; // có dấu: + vào ví, - ra ví
  type: string;
  category?: string | null;
  note?: string | null;
  statementRef?: string | null;
  transferRef?: string;
  refOrderId?: string | null;
  refDepositId?: string;
  refFundTxnId?: string;
  createdAt?: Date;
};

// Ghi 1 dòng sổ + đổi số dư đúng bằng amount của dòng đó.
export async function postWalletTxn(tx: Tx, input: WalletTxnInput) {
  const wallet = await changeBalance(tx, input.walletId, input.amount);
  const data: Record<string, unknown> = { id: uuid() };
  for (const [k, v] of Object.entries(input)) if (v !== undefined) data[k] = v;
  const txn = await tx.walletTxn.create({ data: data as Prisma.WalletTxnUncheckedCreateInput });
  return { txn, wallet };
}

// Xoá các dòng sổ khớp `where` + hoàn số dư đúng theo từng dòng.
export async function reverseWalletTxns(tx: Tx, where: Prisma.WalletTxnWhereInput) {
  const txns = await tx.walletTxn.findMany({ where });
  for (const t of txns) await changeBalance(tx, t.walletId, -Number(t.amount));
  if (txns.length) await tx.walletTxn.deleteMany({ where });
  return txns;
}

// Xoá từng dòng theo id (dòng đã bị xoá bởi request khác -> P2025 -> rollback cả cụm).
export async function deleteWalletTxnsById(tx: Tx, txns: { id: string; walletId: string; amount: unknown }[]) {
  for (const t of txns) {
    await changeBalance(tx, t.walletId, -Number(t.amount));
    await tx.walletTxn.delete({ where: { id: t.id } });
  }
}

// Hoàn tác giao dịch quỹ đã xác nhận (allocate/cashback): trừ lại đúng số đã cộng + xoá dòng sổ liên kết.
export async function reverseFundWalletTxn(tx: Tx, walletId: string, amount: number, fundTxnId: string) {
  await changeBalance(tx, walletId, -amount);
  await tx.walletTxn.deleteMany({ where: { refFundTxnId: fundTxnId } });
}

// Sửa số tiền cọc đã xác nhận: chỉnh số dư theo chênh lệch + sửa số tiền dòng sổ liên kết.
export async function adjustDepositWalletTxn(tx: Tx, walletId: string, depositId: string, diff: number, newAmount: number) {
  await changeBalance(tx, walletId, diff);
  await tx.walletTxn.updateMany({ where: { refDepositId: depositId }, data: { amount: newAmount } });
}

// Cho module orders (force delete đơn có thanh toán): hoàn số dư các payment đã vào ví.
// Dòng sổ tương ứng (refOrderId) caller xoá trong cùng tx.
export async function reversePaymentWallets(tx: Tx, payments: { walletId: string | null; type: string; amountOrig: unknown }[]) {
  for (const p of payments) {
    if (!p.walletId) continue;
    const sign = p.type === "refund" ? -1 : 1;
    await changeBalance(tx, p.walletId, -sign * Number(p.amountOrig));
  }
}

// ---- Wallet CRUD ----

export function listWallets() {
  return prisma.wallet.findMany({ orderBy: { name: "asc" } });
}

export async function walletNames() {
  const wallets = await prisma.wallet.findMany({ orderBy: { name: "asc" }, select: { name: true } });
  return wallets.map((w) => w.name);
}

export function walletsBasic() {
  return prisma.wallet.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true, currency: true } });
}

export async function createWallet(input: { name: string; currency: string; balance?: number }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    if (await tx.wallet.findUnique({ where: { name: input.name } })) throw new LegacyError(409, "WALLET_EXISTS");
    // Số dư ban đầu nhập tay (không có dòng sổ) - giữ như cũ, báo cáo ngày bám mốc wallet.balance.
    const w = await tx.wallet.create({ data: { id: uuid(), name: input.name, currency: input.currency, balance: input.balance ?? 0 } });
    await writeAudit(tx, { actorId: actor.id, targetId: w.id, action: "wallet.created", requestId: actor.requestId, metadata: { balance: input.balance ?? 0 } });
    return w;
  });
}

// Form sửa ví gửi kèm balance (đặt tay số dư) - giữ hành vi cũ, audit ghi số dư trước/sau.
export async function updateWallet(id: string, data: { name?: string; currency?: string; balance?: number }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.wallet.findUnique({ where: { id } });
    const w = await tx.wallet.update({ where: { id }, data });
    await writeAudit(tx, {
      actorId: actor.id, targetId: w.id, action: "wallet.updated", requestId: actor.requestId,
      ...(data.balance !== undefined ? { before: { balance: before ? Number(before.balance) : null }, after: { balance: Number(w.balance) } } : {}),
    });
    return w;
  });
}

export async function deleteWallet(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    // Cọc khách / giao dịch quỹ trỏ tới ví (FK Restrict) cũng tính là "còn giao dịch".
    if ((await countWalletRefs(tx, id)) > 0) throw new LegacyError(409, "HAS_TXNS", "Ví còn giao dịch, không xóa được");
    await tx.wallet.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "wallet.deleted", requestId: actor.requestId });
  });
}

export async function setDailyActual(walletId: string, input: { date: string; actualBalance: number }, actor: Actor) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new LegacyError(404, "WALLET_NOT_FOUND");
  const date = new Date(`${input.date}T00:00:00`);
  const row = await prisma.walletDailyActual.upsert({
    where: { walletId_date: { walletId: wallet.id, date } },
    update: { actualBalance: input.actualBalance, updatedBy: actor.id },
    create: { walletId: wallet.id, date, actualBalance: input.actualBalance, updatedBy: actor.id },
  });
  await logAudit({ actorId: actor.id, targetId: wallet.id, action: "wallet.daily_actual_set", metadata: { date: input.date, actualBalance: input.actualBalance }, requestId: actor.requestId });
  return { date: input.date, actualBalance: Number(row.actualBalance) };
}
