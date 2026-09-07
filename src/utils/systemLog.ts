import { prisma } from "../db.js";
import { logger } from "../logger.js";

type Meta = Record<string, unknown> | undefined;

async function persist(level: "warn" | "error", message: string, meta: Meta): Promise<void> {
  try {
    await prisma.systemLog.create({ data: { level, message, meta: meta as object | undefined } });
  } catch {
    // ghi log DB thất bại không được làm chết request, giống logAudit
  }
}

export function logWarn(meta: Meta, message: string): void {
  logger.warn(meta, message);
  void persist("warn", message, meta);
}

export function logError(meta: Meta, message: string): void {
  logger.error(meta, message);
  void persist("error", message, meta);
}
