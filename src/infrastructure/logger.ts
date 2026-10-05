import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "orderhangnhat-backend", env: process.env.NODE_ENV },
  redact: {
    paths: [
      "authorization", "cookie", "token", "password", "secret", "apiKey", "refreshToken", "accessToken",
      "*.authorization", "*.cookie", "*.token", "*.password", "*.secret", "*.apiKey", "*.refreshToken", "*.accessToken",
      "req.headers.authorization", "req.headers.cookie", "headers.authorization", "headers.cookie",
    ],
    censor: "[REDACTED]",
  },
});
