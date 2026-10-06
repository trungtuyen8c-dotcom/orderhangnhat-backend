import { config } from "./app/config.js";
import { createApp } from "./app/app.js";
import { prisma } from "./infrastructure/prisma.js";
import { ensureBucket } from "./infrastructure/minio.js";
import { startJobs } from "./jobs/alerts.js";
import { startWorkers, stopWorkers } from "./jobs/queues.js";
import "./modules/backup/backup.jobs.js";
import "./modules/sheets/sheet.jobs.js";
import { logger } from "./infrastructure/logger.js";
import { logError } from "./infrastructure/systemLog.js";

const app = createApp();

const server = app.listen(config.port, async () => {
  await ensureBucket();
  // Mọi mã tracking đã đóng hàng đều cần lấy thuế - backfill dữ liệu cũ đóng hàng trước khi cờ needsTax tự set.
  try { await prisma.tracking.updateMany({ where: { packedAt: { not: null }, needsTax: false }, data: { needsTax: true } }); }
  catch (e) { logError({ err: (e as Error).message }, "startup_backfill_needs_tax_failed"); }
  startWorkers();
  startJobs();
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
