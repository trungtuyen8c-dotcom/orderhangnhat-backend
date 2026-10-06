import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { lockFundTxn, writeAudit, type Actor, type Tx } from "./accounting.repository.js";
import { postWalletTxn, reverseFundWalletTxn } from "./wallet.service.js";

// ===== Quỹ tổng (JPY): NV ghi -> CHỜ xác nhận (chưa đụng số dư) -> kế toán Xác nhận thì tiền mới thực đổi =====

const notFound = () => new LegacyError(404, "NOT_FOUND");

function getFund(db: Tx = prisma) {
  return db.fund.upsert({ where: { id: "main" }, update: {}, create: { id: "main", balance: 0 } });
}

type FundTxnLike = { id: string; type: string; amountYen: unknown; walletId: string | null };

// Gọi trong transaction (tx) cùng lúc đổi trạng thái xác nhận.
export async function applyFundTxn(tx: Tx, t: FundTxnLike & { note: string | null }) {
  const amt = Number(t.amountYen);
  if (t.type === "topup") await tx.fund.update({ where: { id: "main" }, data: { balance: { increment: amt } } });
  else if (t.type === "set") await tx.fund.update({ where: { id: "main" }, data: { balance: amt } });
  else if (t.type === "allocate") {
    await tx.fund.update({ where: { id: "main" }, data: { balance: { decrement: amt } } });
    await postWalletTxn(tx, { walletId: t.walletId!, amount: amt, type: "fund_allocate", refFundTxnId: t.id });
  } else if (t.type === "cashback") {
    await postWalletTxn(tx, { walletId: t.walletId!, amount: amt, type: "cashback", statementRef: t.note ?? null, refFundTxnId: t.id });
  }
}

export async function reverseFundTxn(tx: Tx, t: FundTxnLike & { prevBalance: unknown }) {
  const amt = Number(t.amountYen);
  if (t.type === "topup") await tx.fund.update({ where: { id: "main" }, data: { balance: { decrement: amt } } });
  else if (t.type === "set") await tx.fund.update({ where: { id: "main" }, data: { balance: Number(t.prevBalance ?? 0) } });
  else if (t.type === "allocate") {
    await tx.fund.update({ where: { id: "main" }, data: { balance: { increment: amt } } });
    await reverseFundWalletTxn(tx, t.walletId!, amt, t.id);
  } else if (t.type === "cashback") {
    await reverseFundWalletTxn(tx, t.walletId!, amt, t.id);
  }
}

export async function listFund(status: string) {
  const fund = await getFund();
  const where = status === "pending" ? { confirmed: false, fixRequest: null }
    : status === "confirmed" ? { confirmed: true }
    : status === "fix_request" ? { fixRequest: { not: null } }
    : {};
  const txns = await prisma.fundTxn.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  const uids = [...new Set(txns.flatMap((t) => [t.recordedBy, t.confirmedBy]).filter((x): x is string => !!x))];
  const users = await prisma.user.findMany({ where: { id: { in: uids } }, select: { id: true, fullName: true, email: true } });
  const umap = new Map(users.map((u) => [u.id, u.fullName ?? u.email]));
  return {
    balance: Number(fund.balance),
    txns: txns.map((t) => ({ ...t, recordedByName: t.recordedBy ? umap.get(t.recordedBy) ?? null : null, confirmedByName: t.confirmedBy ? umap.get(t.confirmedBy) ?? null : null })),
  };
}

export async function fundCounts() {
  const [pending, confirmed, fixRequest, all] = await Promise.all([
    prisma.fundTxn.count({ where: { confirmed: false, fixRequest: null } }),
    prisma.fundTxn.count({ where: { confirmed: true } }),
    prisma.fundTxn.count({ where: { fixRequest: { not: null } } }),
    prisma.fundTxn.count(),
  ]);
  return { pending, confirmed, fixRequest, all };
}

type FundRecord = { type: "topup" | "set" | "allocate" | "cashback"; amountYen: number; rate?: number | null; walletId?: string; note: string | null };

// Ghi giao dịch quỹ ở trạng thái CHỜ (không đổi số dư). Ví (allocate/cashback) kiểm tra trong cùng tx.
export async function recordFundTxn(input: FundRecord, audit: { action: string; targetId?: string; metadata: Record<string, unknown> }, actor: Actor) {
  const t = await prisma.$transaction(async (tx) => {
    if (input.walletId) {
      const wallet = await tx.wallet.findUnique({ where: { id: input.walletId } });
      if (!wallet) throw new LegacyError(404, "WALLET_NOT_FOUND");
    }
    // "set" ghi đè tuyệt đối -> lưu số dư quỹ lúc ghi để hủy xác nhận hoàn đúng.
    const prevBalance = input.type === "set" ? (await getFund(tx)).balance : undefined;
    const row = await tx.fundTxn.create({
      data: {
        id: uuid(), type: input.type, amountYen: input.amountYen,
        ...(input.rate !== undefined ? { rate: input.rate } : {}),
        ...(input.walletId ? { walletId: input.walletId } : {}),
        ...(prevBalance !== undefined ? { prevBalance } : {}),
        note: input.note, recordedBy: actor.id,
      },
    });
    await writeAudit(tx, { actorId: actor.id, targetId: audit.targetId, action: audit.action, metadata: audit.metadata, requestId: actor.requestId });
    return row;
  });
  eventBus.publish({ eventName: "fund.created", actorId: actor.id, entityType: "fund_txn", entityId: t.id, metadata: { type: t.type, amountYen: Number(t.amountYen), walletId: t.walletId } });
  return t;
}

// Kế toán bấm Xác nhận: tiền thật đổi (quỹ/thẻ) đúng theo loại giao dịch. Bấm lại -> trả về, không đổi tiền lần 2.
export async function confirmFundTxn(id: string, actor: Actor) {
  const { t, changed } = await prisma.$transaction(async (tx) => {
    const cur = await lockFundTxn(tx, id);
    if (!cur) throw notFound();
    if (cur.confirmed) return { t: cur, changed: false };
    await applyFundTxn(tx, cur);
    const updated = await tx.fundTxn.update({ where: { id: cur.id }, data: { confirmed: true, confirmedBy: actor.id, confirmedAt: new Date() } });
    await writeAudit(tx, { actorId: actor.id, targetId: cur.id, action: "fund.confirmed", requestId: actor.requestId, metadata: { type: cur.type, amountYen: Number(cur.amountYen) } });
    return { t: updated, changed: true };
  });
  if (changed) eventBus.publish({ eventName: "fund.confirmed", actorId: actor.id, entityType: "fund_txn", entityId: t.id, metadata: { type: t.type, amountYen: Number(t.amountYen), walletId: t.walletId } });
  return t;
}

// Hủy xác nhận (bấm nhầm): hoàn tác đúng chiều ngược lại
export async function unconfirmFundTxn(id: string, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const cur = await lockFundTxn(tx, id);
    if (!cur) throw notFound();
    if (!cur.confirmed) return cur;
    await reverseFundTxn(tx, cur);
    const updated = await tx.fundTxn.update({ where: { id: cur.id }, data: { confirmed: false, confirmedBy: null, confirmedAt: null } });
    await writeAudit(tx, { actorId: actor.id, targetId: cur.id, action: "fund.unconfirmed", requestId: actor.requestId });
    return updated;
  });
}

export async function deleteFundTxn(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const cur = await lockFundTxn(tx, id);
    if (!cur) throw notFound();
    if (cur.confirmed) await reverseFundTxn(tx, cur);
    await tx.fundTxn.delete({ where: { id: cur.id } });
    await writeAudit(tx, { actorId: actor.id, targetId: cur.id, action: "fund.deleted", requestId: actor.requestId });
  });
}

export async function requestFundFix(id: string, note: string, actor: Actor) {
  const t = await prisma.fundTxn.findUnique({ where: { id } });
  if (!t) throw notFound();
  await prisma.fundTxn.update({ where: { id: t.id }, data: { fixRequest: note, fixRequestedAt: new Date() } });
  await logAudit({ actorId: actor.id, targetId: t.id, action: "fund.fix_requested", metadata: { note }, requestId: actor.requestId });
}

export async function resolveFundFix(id: string, actor: Actor) {
  const t = await prisma.fundTxn.findUnique({ where: { id } });
  if (!t) throw notFound();
  await prisma.fundTxn.update({ where: { id: t.id }, data: { fixRequest: null, fixRequestedAt: null } });
  await logAudit({ actorId: actor.id, targetId: t.id, action: "fund.fix_resolved", requestId: actor.requestId });
}
