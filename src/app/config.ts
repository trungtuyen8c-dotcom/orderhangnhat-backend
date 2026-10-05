import dotenv from "dotenv";
dotenv.config();

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

function req(name: string, devFallback?: string): string {
  const v = process.env[name] ?? (isProd ? undefined : devFallback);
  if (v === undefined || v === "") throw new Error(`Missing env ${name}${isProd ? " (required in production)" : ""}`);
  return v;
}

function list(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv,
  isProd,
  jwtSecret: req("JWT_SECRET", "dev_secret_change_me"),
  accessTtl: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
  refreshTtl: Number(process.env.REFRESH_TOKEN_TTL ?? 604800),
  redisUrl: req("REDIS_URL", "redis://localhost:6379"),
  // Rỗng = cho mọi origin (chỉ dev). Prod phải đặt CORS_ORIGINS, nếu không chỉ same-origin (qua nginx) chạy được.
  corsOrigins: list("CORS_ORIGINS"),
  // Mặc định bật ở prod; tắt tạm bằng COOKIE_SECURE=false khi chưa có HTTPS.
  cookieSecure: (process.env.COOKIE_SECURE ?? (isProd ? "true" : "false")) === "true",
  // Tắt worker trong process API (vd khi chạy worker riêng hoặc test).
  workersEnabled: (process.env.WORKERS_ENABLED ?? "true") === "true",
};
