import { v4 as uuid } from "uuid";
import type { BackupRun } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { enqueue } from "../../jobs/queues.js";
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
    throw new LegacyError(400, "BAD_TOKEN", "Token không hợp lệ");
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
export async function startManualBackup(actor: Actor) {
  if ((await prisma.backupRun.count({ where: ACTIVE })) > 0) throw new LegacyError(409, "BUSY", "Đang có bản backup chạy");
  const run = await prisma.backupRun.create({ data: { id: uuid(), kind: "manual", status: "pending", triggeredBy: actor.id } });
  // attempts: 1 - runBackup tự ghi failed vào BackupRun, chạy lại cùng runId không có ý nghĩa.
  await enqueue("backup.create", { runId: run.id }, { attempts: 1 });
  await logAudit({ actorId: actor.id, targetId: run.id, action: "backup.run", requestId: actor.requestId, entity: "backup_run" });
  return serializeRun(run);
}
