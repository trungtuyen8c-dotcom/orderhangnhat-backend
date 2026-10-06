import { prisma } from "./prisma.js";
import { logger } from "./logger.js";

type Meta = Record<string, unknown> | undefined;

async function persist(level: "warn" | "error", message: string, meta: Meta): Promise<void> {
  try {
    await prisma.systemLog.create({ data: { level, message, meta: meta as object | undefined } });
  } catch (e) {
    // Ghi DB lỗi không được làm chết request - vẫn còn bản ghi stdout ở trên.
    logger.warn({ err: (e as Error).message }, "system_log_persist_failed");
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
