import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
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

// Số dư đầu kỳ / điều chỉnh tay là 1 DÒNG SỔ như mọi giao dịch khác (không sửa thẳng Wallet.balance) -> sao kê, đối soát
// ngày, báo cáo đều thấy. Thẻ dùng chung nhiều dự án: số dư thật = đầu kỳ + tổng giao dịch của mọi dự án (cột project).
export const OPENING_REF = "opening";

export async function createWallet(input: { name: string; currency: string; balance?: number }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    if (await tx.wallet.findUnique({ where: { name: input.name } })) throw new AppError("WALLET_EXISTS", 409);
    const w = await tx.wallet.create({ data: { id: uuid(), name: input.name, currency: input.currency, balance: 0 } });
    if (input.balance) await postWalletTxn(tx, { walletId: w.id, amount: input.balance, type: "opening", category: "Số dư đầu kỳ", statementRef: OPENING_REF });
    await writeAudit(tx, { actorId: actor.id, targetId: w.id, action: "wallet.created", requestId: actor.requestId, metadata: { balance: input.balance ?? 0 } });
    return tx.wallet.findUniqueOrThrow({ where: { id: w.id } });
  });
}

// Sửa tên/tiền tệ. Gửi kèm balance (đặt số dư tay) -> ghi 1 dòng "Điều chỉnh số dư" đúng phần chênh, không ghi đè.
export async function updateWallet(id: string, data: { name?: string; currency?: string; balance?: number }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const before = await tx.wallet.findUnique({ where: { id } });
    if (!before) throw new AppError("WALLET_NOT_FOUND", 404);
    const { balance, ...rest } = data;
    if (Object.keys(rest).length) await tx.wallet.update({ where: { id }, data: rest });
    if (balance !== undefined && balance !== Number(before.balance)) {
      await postWalletTxn(tx, { walletId: id, amount: balance - Number(before.balance), type: "adjust", category: "Điều chỉnh số dư" });
    }
    const w = await tx.wallet.findUniqueOrThrow({ where: { id } });
    await writeAudit(tx, {
      actorId: actor.id, targetId: w.id, action: "wallet.updated", requestId: actor.requestId,
      ...(balance !== undefined ? { before: { balance: Number(before.balance) }, after: { balance: Number(w.balance) } } : {}),
    });
    return w;
  });
}

// Đặt số dư đầu kỳ tại 1 ngày: thay dòng đầu kỳ cũ (nếu có) bằng dòng mới ghi đúng 0h ngày đó.
export async function setWalletOpening(id: string, input: { amount: number; date: Date }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const w = await tx.wallet.findUnique({ where: { id } });
    if (!w) throw new AppError("WALLET_NOT_FOUND", 404);
    await reverseWalletTxns(tx, { walletId: id, statementRef: OPENING_REF });
    if (input.amount) {
      await postWalletTxn(tx, { walletId: id, amount: input.amount, type: "opening", category: "Số dư đầu kỳ", statementRef: OPENING_REF, createdAt: input.date });
    }
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "wallet.opening_set", requestId: actor.requestId, metadata: { amount: input.amount, date: input.date } });
    return tx.wallet.findUniqueOrThrow({ where: { id } });
  });
}

// Sổ giao dịch thẻ để GỘP với dự án khác dùng chung thẻ: mỗi dòng có tên thẻ + dự án + ngày + số tiền có dấu.
// Gộp N dự án: số dư thẻ = tổng amount mọi dòng của thẻ đó (đầu kỳ là 1 dòng, chỉ 1 dự án ghi).
export async function walletLedger(q: { from?: Date; to?: Date; wallet?: string }) {
  const rows = await prisma.walletTxn.findMany({
    where: {
      ...(q.wallet ? { wallet: { name: q.wallet } } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
    },
    orderBy: { createdAt: "asc" },
    include: { wallet: { select: { name: true, currency: true } } },
    take: 20000,
  });
  return rows.map((t) => ({
    id: t.id, wallet: t.wallet.name, currency: t.wallet.currency, project: t.project, date: t.createdAt,
    amount: Number(t.amount), type: t.type, category: t.category, note: t.note,
  }));
}

export async function deleteWallet(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    // Cọc khách / giao dịch quỹ trỏ tới ví (FK Restrict) cũng tính là "còn giao dịch".
    if ((await countWalletRefs(tx, id)) > 0) throw new AppError("HAS_TXNS", 409, "Ví còn giao dịch, không xóa được");
    await tx.wallet.delete({ where: { id } });
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "wallet.deleted", requestId: actor.requestId });
  });
}

export async function setDailyActual(walletId: string, input: { date: string; actualBalance: number }, actor: Actor) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new AppError("WALLET_NOT_FOUND", 404);
  const date = new Date(`${input.date}T00:00:00`);
  const row = await prisma.walletDailyActual.upsert({
    where: { walletId_date: { walletId: wallet.id, date } },
    update: { actualBalance: input.actualBalance, updatedBy: actor.id },
    create: { walletId: wallet.id, date, actualBalance: input.actualBalance, updatedBy: actor.id },
  });
  await logAudit({ actorId: actor.id, targetId: wallet.id, action: "wallet.daily_actual_set", metadata: { date: input.date, actualBalance: input.actualBalance }, requestId: actor.requestId });
  return { date: input.date, actualBalance: Number(row.actualBalance) };
}
