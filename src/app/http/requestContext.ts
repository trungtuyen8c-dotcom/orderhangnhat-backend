import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";
import { logger } from "../../infrastructure/logger.js";

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header("x-request-id");
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader("X-Request-Id", req.requestId);
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    if (req.path === "/api/health" || req.path === "/api/ready" || req.path === "/metrics") return;
    const duration_ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    logger[level]({
      request_id: req.requestId, method: req.method, path: req.originalUrl.split("?")[0],
      status: res.statusCode, duration_ms, user_id: req.user?.id,
    }, "request_completed");
  });
  next();
}
