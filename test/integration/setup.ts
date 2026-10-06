import { afterAll, beforeAll } from "vitest";
import { startWorkers, stopWorkers } from "../../src/jobs/queues.js";
import { runCli } from "./globalSetup.js";
import { prisma, redis, server } from "./helpers.js";

// Mỗi file test bắt đầu từ DB vừa seed + Redis rỗng, rồi bật BullMQ worker (notification/sheet job chạy thật).
async function resetData() {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length) {
    await prisma.$executeRawUnsafe(`TRUNCATE ${rows.map((r) => `"public"."${r.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
  }
  runCli("tsx", ["prisma/seed.ts"]);
  await redis.flushdb();
}

beforeAll(async () => {
  await resetData();
  startWorkers({ force: true });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
  await stopWorkers();
  // systemLog ghi DB kiểu fire-and-forget - chờ chút cho xong trước khi ngắt kết nối.
  await new Promise((r) => setTimeout(r, 200));
  await prisma.$disconnect();
  redis.disconnect();
});
