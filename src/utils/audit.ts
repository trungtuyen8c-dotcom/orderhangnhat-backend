import { prisma } from "../db.js";

export async function logAudit(params: {
  actorId?: string | null;
  targetId?: string | null;
  action: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
}): Promise<void> {
  try {
    await prisma.accessAudit.create({
      data: {
        actorId: params.actorId ?? null,
        targetId: params.targetId ?? null,
        action: params.action,
        metadata: params.metadata as object | undefined,
        ipAddress: params.ip ?? null,
      },
    });
  } catch {
    // audit không được làm chết request
  }
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
  } catch {
    // không làm chết request
  }
}
