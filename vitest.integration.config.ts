import { defineConfig } from "vitest/config";

// Integration test: PostgreSQL + Redis thật (DATABASE_URL/REDIS_URL bắt buộc, tên DB phải chứa "test").
// Chạy tuần tự từng file (cùng 1 DB), mỗi file reset dữ liệu ở beforeAll (test/integration/setup.ts).
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    globals: true,
    globalSetup: ["./test/integration/globalSetup.ts"],
    setupFiles: ["./test/integration/setup.ts"],
    pool: "forks",
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
      JWT_SECRET: "integration_test_secret",
      ADMIN_EMAIL: "admin@orderhn.local",
      ADMIN_PASSWORD: "Admin@12345",
      WORKERS_ENABLED: "true",
      BACKUP_CRON: "",
      COOKIE_SECURE: "false",
      // Không bao giờ gọi Google/MinIO thật từ test (dotenv không ghi đè biến đã có, kể cả rỗng).
      GOOGLE_SA_EMAIL: "",
      GOOGLE_SA_PRIVATE_KEY: "",
      GSHEET_ID: "",
      MINIO_ENDPOINT: "127.0.0.1",
      MINIO_PORT: "1",
    },
  },
});
