import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { getAlerts, getOverview } from "./stats.service.js";

export const statsRouter = Router();
statsRouter.use(authenticateEither);

statsRouter.get("/alerts", authorize("stats.view"), asyncHandler(async (_req, res) => {
  res.json(await getAlerts());
}));

statsRouter.get("/", authorize("stats.view"), asyncHandler(async (_req, res) => {
  res.json(await getOverview());
}));
