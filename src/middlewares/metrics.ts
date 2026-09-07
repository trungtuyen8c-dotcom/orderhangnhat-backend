import client from "prom-client";
import type { Request, Response, NextFunction } from "express";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

export const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Tổng số request HTTP",
  labelNames: ["method", "path", "status_code"],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Thời gian xử lý request",
  labelNames: ["method", "path"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const cacheHits = new client.Counter({ name: "app_cache_hits_total", help: "Cache hit", labelNames: ["feature"], registers: [register] });
export const cacheMisses = new client.Counter({ name: "app_cache_misses_total", help: "Cache miss", labelNames: ["feature"], registers: [register] });

function normalizePath(req: Request): string {
  return req.route ? req.baseUrl + req.route.path : req.path;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/metrics") return next();
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const path = normalizePath(req);
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc({ method: req.method, path, status_code: String(res.statusCode) });
    httpRequestDuration.observe({ method: req.method, path }, seconds);
  });
  next();
}

export async function metricsHandler(_req: Request, res: Response) {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
}
