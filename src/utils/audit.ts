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
