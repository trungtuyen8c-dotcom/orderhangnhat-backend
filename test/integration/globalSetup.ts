import { execFileSync } from "node:child_process";
import { Redis } from "ioredis";

// Chạy 1 lần trong process chính của vitest: dựng DB sạch (drop schema -> migrate deploy -> seed) + xoá Redis.
// Từ chối chạy khi tên DB không chứa "test" để không bao giờ xoá nhầm DB thật.

export const SEED_ENV = {
  ADMIN_EMAIL: "admin@orderhn.local",
  ADMIN_PASSWORD: "Admin@12345",
};

export function requireEnv() {
  const missing = ["DATABASE_URL", "REDIS_URL"].filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(
      `[integration] Thiếu env ${missing.join(", ")}. Ví dụ:\n` +
        "  docker run -d --rm --name it-pg -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=orderhn_test -p 127.0.0.1:55440:5432 postgres:16-alpine\n" +
        "  docker run -d --rm --name it-redis -p 127.0.0.1:56380:6379 redis:7-alpine\n" +
        "  DATABASE_URL=postgresql://postgres:pg@127.0.0.1:55440/orderhn_test REDIS_URL=redis://127.0.0.1:56380/0 npm run test:integration",
    );
  }
  const dbName = new URL(process.env.DATABASE_URL!).pathname.replace(/^\//, "");
  if (!/test/i.test(dbName)) {
    throw new Error(`[integration] DATABASE_URL trỏ tới DB "${dbName}" - tên DB phải chứa "test" (suite sẽ XOÁ toàn bộ dữ liệu).`);
  }
}

const bin = (name: string) => `node_modules/.bin/${name}`;

export function runCli(cmd: string, args: string[], input?: string) {
  return execFileSync(bin(cmd), args, {
    env: { ...process.env, ...SEED_ENV },
    stdio: input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    input,
    encoding: "utf8",
  });
}

export default async function setup() {
  requireEnv();
  try {
    runCli("prisma", ["db", "execute", "--stdin", "--schema", "prisma/schema.prisma"], "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
    runCli("prisma", ["migrate", "deploy"]);
    runCli("tsx", ["prisma/seed.ts"]);
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`[integration] Dựng DB thất bại: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
  }
  const redis = new Redis(process.env.REDIS_URL!);
  await redis.flushdb();
  await redis.quit();
}
