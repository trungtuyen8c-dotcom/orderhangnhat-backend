import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "warn",
  base: { service: "orderhangnhat-backend", env: process.env.NODE_ENV },
});
