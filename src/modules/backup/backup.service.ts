import { v4 as uuid } from "uuid";
import type { BackupRun } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { enqueue } from "../../jobs/queues.js";
import { logger } from "../../infrastructure/logger.js";
import { logWarn } from "../../infrastructure/systemLog.js";
import { rcloneConnected, setRcloneToken, disconnectRclone } from "./backup.runner.js";

type Actor = { id: string; requestId?: string };
const ACTIVE = { status: { in: ["pending", "running"] } };

// BigInt không JSON được -> number (file backup không vượt 2^53 byte).
export const serializeRun = (r: BackupRun) => ({ ...r, sizeBytes: Number(r.sizeBytes ?? 0) });

export async function getStatus() {
  const [connected, last, running] = await Promise.all([
    rcloneConnected(),
    prisma.backupRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.backupRun.count({ where: ACTIVE }),
  ]);
  return { connected, running: running > 0, last: last ? serializeRun(last) : null };
}

export async function listRuns() {
  const runs = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 });
  return runs.map(serializeRun);
}

export async function connectDrive(token: string, actor: Actor) {
  try {
    await setRcloneToken(token);
  } catch {
    throw new AppError("BAD_TOKEN", 400, "Token không hợp lệ");
  }
  await logAudit({ actorId: actor.id, action: "backup.connect_drive", requestId: actor.requestId, entity: "backup" });
  return { connected: await rcloneConnected() };
}

export async function disconnectDrive(actor: Actor) {
  await disconnectRclone();
  await logAudit({ actorId: actor.id, action: "backup.disconnect_drive", requestId: actor.requestId, entity: "backup" });
  return { connected: false };
}

// Tạo BackupRun pending rồi đẩy job 'backup.create' - worker chạy runBackup (xem backup.jobs.ts).
// Trả null nếu đang có run pending/running (guard BUSY dùng chung cho manual + scheduled).
async function createAndEnqueueRun(kind: "manual" | "scheduled", triggeredBy: string | null) {
  if ((await prisma.backupRun.count({ where: ACTIVE })) > 0) return null;
  const run = await prisma.backupRun.create({ data: { id: uuid(), kind, status: "pending", triggeredBy } });
  // attempts: 1 - runBackup tự ghi failed vào BackupRun, chạy lại cùng runId không có ý nghĩa.
  await enqueue("backup.create", { runId: run.id }, { attempts: 1 });
  return run;
}

export async function startManualBackup(actor: Actor) {
  const run = await createAndEnqueueRun("manual", actor.id);
  if (!run) throw new AppError("BUSY", 409, "Đang có bản backup chạy");
  await logAudit({ actorId: actor.id, targetId: run.id, action: "backup.run", requestId: actor.requestId, entity: "backup_run" });
  return serializeRun(run);
}

// Cron BACKUP_CRON gọi. Chưa nối Drive hoặc đang có run -> bỏ qua lượt này (log), không tạo run failed mỗi ngày.
export async function startScheduledBackup(): Promise<{ started: boolean; reason?: string; runId?: string }> {
  if (!(await rcloneConnected())) {
    logger.warn({ kind: "scheduled" }, "backup_scheduled_skipped_not_connected");
    return { started: false, reason: "NOT_CONNECTED" };
  }
  const run = await createAndEnqueueRun("scheduled", null);
  if (!run) {
    logger.warn({ kind: "scheduled" }, "backup_scheduled_skipped_busy");
    return { started: false, reason: "BUSY" };
  }
  logger.info({ run_id: run.id, kind: "scheduled" }, "backup_scheduled_enqueued");
  return { started: true, runId: run.id };
}

export const STUCK_RUN_MAX_AGE_MS = 6 * 3600 * 1000;

// Run kẹt pending/running quá lâu (worker chết giữa chừng, job mất) chặn mọi run mới vì guard BUSY -> đánh failed.
export async function failStuckRuns(maxAgeMs = STUCK_RUN_MAX_AGE_MS, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - maxAgeMs);
  const { count } = await prisma.backupRun.updateMany({
    where: { ...ACTIVE, startedAt: { lt: cutoff } },
    data: { status: "failed", finishedAt: now, error: "Kẹt pending/running quá lâu - đánh failed khi worker khởi động" },
  });
  if (count) logWarn({ count, cutoff: cutoff.toISOString() }, "backup_stuck_runs_failed");
  return count;
}
