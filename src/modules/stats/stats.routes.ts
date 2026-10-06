import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize, hasPermission } from "../../middlewares/authorize.js";
import { getAlerts, getMonthly, getOverview, parseMonthsParam } from "./stats.service.js";

export const statsRouter = Router();
statsRouter.use(authenticateEither);

statsRouter.get("/alerts", authorize("stats.view"), asyncHandler(async (_req, res) => {
  res.json(await getAlerts());
}));

// Biểu đồ Dashboard: ?months=1..24 (mặc định 12). revenueVnd/spendJpy chỉ có khi caller có orders.read.
statsRouter.get("/monthly", authorize("stats.view"), asyncHandler(async (req, res) => {
  res.json({ months: await getMonthly(parseMonthsParam(req.query.months), await hasPermission(req, "orders.read")) });
}));

statsRouter.get("/", authorize("stats.view"), asyncHandler(async (_req, res) => {
  res.json(await getOverview());
}));
