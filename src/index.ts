import { config } from "./app/config.js";
import { createApp } from "./app/app.js";
import { prisma } from "./infrastructure/prisma.js";
import { ensureBucket } from "./infrastructure/minio.js";
import { startBackground } from "./jobs/runtime.js";
import { stopWorkers } from "./jobs/queues.js";
import "./modules/backup/backup.jobs.js";
import "./modules/sheets/sheet.jobs.js";
import "./modules/notifications/notification.jobs.js";
import "./modules/notifications/notification.subscribers.js";
import { logger } from "./infrastructure/logger.js";
import { logError } from "./infrastructure/systemLog.js";
import { checkTotpKeyAtStartup } from "./modules/auth/twoFactor.service.js";

const app = createApp();

const server = app.listen(config.port, async () => {
  await ensureBucket();
  // Mọi mã tracking đã đóng hàng đều cần lấy thuế - backfill dữ liệu cũ đóng hàng trước khi cờ needsTax tự set.
  try { await prisma.tracking.updateMany({ where: { packedAt: { not: null }, needsTax: false }, data: { needsTax: true } }); }
  catch (e) { logError({ err: (e as Error).message }, "startup_backfill_needs_tax_failed"); }
  // Worker + cron trong process API trừ khi WORKERS_ENABLED=false (khi đó chạy src/worker.ts riêng).
  await startBackground({ role: "api" });
  await checkTotpKeyAtStartup();
  logger.info({ port: config.port }, "api_listening");
});

async function shutdown(signal: string) {
  logger.info({ signal }, "shutdown");
  server.close();
  await stopWorkers().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
