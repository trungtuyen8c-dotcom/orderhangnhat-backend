import type { Prisma } from "@prisma/client";
import { prisma } from "../infrastructure/prisma.js";
import { logger } from "../infrastructure/logger.js";

export type AuditParams = {
  actorId?: string | null;
  targetId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string;
  entity?: string;
  before?: unknown;
  after?: unknown;
};

// requestId/entity/before/after nằm trong metadata JSON (không đổi schema access_audit).
export function buildAuditMetadata(p: AuditParams): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = { ...(p.metadata ?? {}) };
  if (p.requestId) meta.requestId = p.requestId;
  if (p.entity) meta.entity = p.entity;
  if (p.before !== undefined) meta.before = p.before;
  if (p.after !== undefined) meta.after = p.after;
  return Object.keys(meta).length ? meta : p.metadata;
}

// Không bao giờ throw - audit lỗi không được làm chết request.
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await prisma.accessAudit.create({
      data: {
        actorId: params.actorId ?? null,
        targetId: params.targetId ?? null,
        action: params.action,
        metadata: buildAuditMetadata(params) as object | undefined,
        ipAddress: params.ip ?? null,
      },
    });
  } catch (e) {
    logger.warn({ action: params.action, request_id: params.requestId, err: (e as Error).message }, "audit_write_failed");
  }
}

// Ghi audit TRONG transaction nghiệp vụ: lỗi ghi audit -> rollback cả thao tác (khác logAudit, không nuốt lỗi).
export async function logAuditTx(tx: Prisma.TransactionClient, params: AuditParams): Promise<void> {
  await tx.accessAudit.create({
    data: {
      actorId: params.actorId ?? null,
      targetId: params.targetId ?? null,
      action: params.action,
      metadata: buildAuditMetadata(params) as object | undefined,
      ipAddress: params.ip ?? null,
    },
  });
}

// Lịch sử đơn (kiểu Google Sheet): lưu diff từng lần sửa + tên người sửa
export async function logOrder(params: {
  orderId: string;
  actorId?: string | null;
  action: string;
  changes?: unknown;
}): Promise<void> {
  try {
    let actorName: string | null = null;
    if (params.actorId) {
      const u = await prisma.user.findUnique({ where: { id: params.actorId }, select: { fullName: true, email: true } });
      actorName = u?.fullName ?? u?.email ?? null;
    }
    await prisma.orderLog.create({
      data: {
        orderId: params.orderId,
        actorId: params.actorId ?? null,
        actorName,
        action: params.action,
        changes: (params.changes ?? undefined) as object | undefined,
      },
    });
  } catch (e) {
    logger.warn({ order_id: params.orderId, action: params.action, err: (e as Error).message }, "order_log_write_failed");
  }
}
