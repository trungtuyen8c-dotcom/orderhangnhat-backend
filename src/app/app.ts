import express from "express";
import { AppError } from "./errors/AppError.js";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { requestContext } from "./http/requestContext.js";
import { errorHandler } from "./errors/errorHandler.js";
import { prisma } from "../infrastructure/prisma.js";
import { redis } from "../infrastructure/redis.js";
import { metricsMiddleware, metricsHandler } from "../middlewares/metrics.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { meRouter } from "../modules/me/me.routes.js";
import { apiKeysRouter } from "../modules/api-keys/api-keys.routes.js";
import { ordersRouter } from "../modules/orders/orders.routes.js";
import { customersRouter } from "../modules/customers/customers.routes.js";
import { statsRouter } from "../modules/stats/stats.routes.js";
import { trackingRouter } from "../modules/tracking/tracking.routes.js";
import { shipmentsRouter } from "../modules/shipments/shipments.routes.js";
import { accountingRouter } from "../modules/accounting/accounting.routes.js";
import { warehouseRouter } from "../modules/warehouse/warehouse.routes.js";
import { controlRouter } from "../modules/control/control.routes.js";
import { companyCostRouter } from "../modules/companycost/companycost.routes.js";
import { payrollRouter } from "../modules/payroll/payroll.routes.js";
import { publicRouter } from "../modules/public/public.routes.js";
import { adminRouter } from "../modules/admin/admin.routes.js";
import { scrapeRouter } from "../modules/scrape/scrape.routes.js";
import { backupRouter } from "../modules/backup/backup.routes.js";
import { systemLogsRouter } from "../modules/system-logs/system-logs.routes.js";
import { clientLogsRouter } from "../modules/client-logs/client-logs.routes.js";
import { extRouter } from "../modules/ext/ext.routes.js";

export function createApp() {
  const app = express();
  app.set("trust proxy", true);
  app.use(requestContext);
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use(cors({
    credentials: true,
    origin: config.corsOrigins.length ? config.corsOrigins : !config.isProd,
  }));
  app.use(metricsMiddleware);

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/ready", async (_req, res) => {
    const checks: Record<string, "ok" | "fail"> = {};
    try { await prisma.$queryRaw`SELECT 1`; checks.database = "ok"; } catch { checks.database = "fail"; }
    try { await redis.ping(); checks.redis = "ok"; } catch { checks.redis = "fail"; }
    const ok = Object.values(checks).every((v) => v === "ok");
    res.status(ok ? 200 : 503).json({ status: ok ? "ready" : "not_ready", checks });
  });
  app.get("/metrics", metricsHandler); // Nginx chặn path này ra ngoài (deny all)

  app.use("/api/auth", authRouter);
  app.use("/api/me", meRouter);
  app.use("/api/api-keys", apiKeysRouter);
  app.use("/api/ext", extRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/scrape", scrapeRouter);
  app.use("/api/customers", customersRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/trackings", trackingRouter);
  app.use("/api/shipments", shipmentsRouter);
  app.use("/api/accounting", accountingRouter);
  app.use("/api/warehouse", warehouseRouter);
  app.use("/api/control", controlRouter);
  app.use("/api/company-costs", companyCostRouter);
  app.use("/api/payroll", payrollRouter);
  app.use("/api/public", publicRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/system-logs", systemLogsRouter);
  app.use("/api/client-logs", clientLogsRouter);
  app.use("/api/backup", backupRouter);

  app.use("/api", (_req, _res, next) => next(new AppError("NOT_FOUND", 404, "API không tồn tại")));
  app.use(errorHandler);
  return app;
}
