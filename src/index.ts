import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { randomUUID } from "crypto";
import { config } from "./config.js";
import { ensureBucket } from "./minio.js";
import { startJobs } from "./jobs/alerts.js";
import { logger } from "./logger.js";
import { metricsMiddleware, metricsHandler } from "./middlewares/metrics.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { meRouter } from "./modules/me/me.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";
import { customersRouter } from "./modules/customers/customers.routes.js";
import { statsRouter } from "./modules/stats/stats.routes.js";
import { trackingRouter } from "./modules/tracking/tracking.routes.js";
import { shipmentsRouter } from "./modules/shipments/shipments.routes.js";
import { accountingRouter } from "./modules/accounting/accounting.routes.js";
import { warehouseRouter } from "./modules/warehouse/warehouse.routes.js";
import { controlRouter } from "./modules/control/control.routes.js";
import { companyCostRouter } from "./modules/companycost/companycost.routes.js";
import { payrollRouter } from "./modules/payroll/payroll.routes.js";
import { publicRouter } from "./modules/public/public.routes.js";
import { adminRouter } from "./modules/admin/admin.routes.js";
import { scrapeRouter } from "./modules/scrape/scrape.routes.js";
import { backupRouter } from "./modules/backup/backup.routes.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use((req, _res, next) => { req.requestId = randomUUID(); next(); });
app.use(metricsMiddleware);

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.get("/metrics", metricsHandler); // Nginx chặn path này ra ngoài (deny all)
app.use("/api/auth", authRouter);
app.use("/api/me", meRouter);
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
app.use("/api/backup", backupRouter);

// Error handler
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ request_id: req.requestId, err: { message: err?.message, stack: err?.stack } }, "request failed");
  res.status(500).json({ error: "INTERNAL" });
});

app.listen(config.port, async () => {
  await ensureBucket();
  startJobs();
  console.log(`API listening on :${config.port}`);
});
