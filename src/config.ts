import dotenv from "dotenv";
dotenv.config();

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  jwtSecret: req("JWT_SECRET", "dev_secret_change_me"),
  accessTtl: Number(process.env.ACCESS_TOKEN_TTL ?? 900),
  refreshTtl: Number(process.env.REFRESH_TOKEN_TTL ?? 604800),
  redisUrl: req("REDIS_URL", "redis://localhost:6379"),
};
