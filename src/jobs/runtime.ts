import cron from "node-cron";
import { config } from "../app/config.js";
import { logger } from "../infrastructure/logger.js";
import { logError } from "../infrastructure/systemLog.js";
import { startJobs } from "./alerts.js";
import { startWorkers } from "./queues.js";
import { failStuckRuns, startScheduledBackup } from "../modules/backup/backup.service.js";

export const BACKUP_TIMEZONE = "Asia/Ho_Chi_Minh";

// Trả true nếu đã đăng ký cron backup. Rỗng = tắt, sai cú pháp = log lỗi + bỏ qua (không làm chết process).
export function scheduleBackupCron(expr: string = config.backupCron): boolean {
  const e = expr.trim();
  if (!e) {
    logger.info("backup_cron_disabled");
    return false;
  }
  if (!cron.validate(e)) {
    logError({ expr: e }, "backup_cron_invalid");
    return false;
  }
  cron.schedule(e, () => {
    startScheduledBackup().catch((err) => logError({ err: (err as Error).message }, "backup_scheduled_failed"));
  }, { timezone: BACKUP_TIMEZONE });
  logger.info({ expr: e, tz: BACKUP_TIMEZONE }, "backup_cron_scheduled");
  return true;
}

// Worker BullMQ + mọi cron. API gọi không force -> tôn trọng WORKERS_ENABLED (tránh cron chạy trùng khi có
// process worker riêng); src/worker.ts gọi force.
export async function startBackground(opts: { force?: boolean; role: "api" | "worker" }): Promise<boolean> {
  if (!opts.force && !config.workersEnabled) {
    logger.info({ role: opts.role }, "background_disabled_by_env");
    return false;
  }
  try {
    await failStuckRuns();
  } catch (e) {
    logError({ err: (e as Error).message }, "backup_stuck_cleanup_failed");
  }
  startWorkers({ force: true });
  startJobs();
  scheduleBackupCron();
  logger.info({ role: opts.role }, "background_started");
  return true;
}
