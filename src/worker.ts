import "./app/config.js";
import { prisma } from "./infrastructure/prisma.js";
import { startBackground } from "./jobs/runtime.js";
import { stopWorkers } from "./jobs/queues.js";
import "./modules/backup/backup.jobs.js";
import "./modules/sheets/sheet.jobs.js";
import "./modules/notifications/notification.jobs.js";
import { logger } from "./infrastructure/logger.js";
import { logError } from "./infrastructure/systemLog.js";

// Process worker riêng (npm run start:worker): BullMQ worker + cron, không mở HTTP.
// Chạy kèm API đặt WORKERS_ENABLED=false để cron/worker không chạy trùng 2 nơi.
startBackground({ force: true, role: "worker" }).catch((e) => {
  logError({ err: (e as Error).message }, "worker_start_failed");
  process.exit(1);
});

async function shutdown(signal: string) {
  logger.info({ signal }, "worker_shutdown");
  await stopWorkers().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
