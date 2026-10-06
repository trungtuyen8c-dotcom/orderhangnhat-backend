import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { getMe, listOnline } from "./me.service.js";

export const meRouter = Router();

meRouter.get("/", authenticate, asyncHandler(async (req, res) => {
  res.json(await getMe(req.user!));
}));

meRouter.get("/online", authenticate, asyncHandler(async (_req, res) => {
  res.json(await listOnline());
}));
