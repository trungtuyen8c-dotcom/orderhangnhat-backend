import type { Prisma } from "@prisma/client";
import { buildAuditMetadata, type AuditParams } from "../../app/audit.js";

export type Tx = Prisma.TransactionClient;
export type Actor = { id: string; requestId?: string; roles?: string[] };

// Khoá dòng (SELECT ... FOR UPDATE) trong transaction: request đồng thời trên cùng bản ghi phải chờ nhau,
// đọc lại trạng thái sau khi khoá -> không xác nhận/hoàn tác/sửa tiền 2 lần.
export async function lockDeposit(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM customer_deposits WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.customerDeposit.findUnique({ where: { id } });
}

export async function lockFundTxn(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM fund_txns WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.fundTxn.findUnique({ where: { id } });
}

export async function lockOrder(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.order.findUnique({ where: { id } });
}

export async function lockCustomer(tx: Tx, id: string) {
  await tx.$queryRaw`SELECT id FROM customers WHERE id = ${id}::uuid FOR UPDATE`;
  return tx.customer.findUnique({ where: { id } });
}

// Audit cho thao tác tiền ghi CÙNG transaction -> chỉ tồn tại khi thao tác đã commit.
export async function writeAudit(tx: Tx, p: AuditParams) {
  await tx.accessAudit.create({
    data: {
      actorId: p.actorId ?? null,
      targetId: p.targetId ?? null,
      action: p.action,
      metadata: buildAuditMetadata(p) as object | undefined,
      ipAddress: p.ip ?? null,
    },
  });
}

export async function countWalletRefs(tx: Tx, walletId: string) {
  const [txns, deposits, fundTxns] = await Promise.all([
    tx.walletTxn.count({ where: { walletId } }),
    tx.customerDeposit.count({ where: { walletId } }),
    tx.fundTxn.count({ where: { walletId } }),
  ]);
  return txns + deposits + fundTxns;
}

// Người dùng (không có role đặc quyền) có quyền accounting.refund qua role được gán hay không.
export async function userHasPermission(tx: Tx, userId: string, key: string) {
  const n = await tx.permission.count({ where: { key, roles: { some: { role: { users: { some: { userId } } } } } } });
  return n > 0;
}
