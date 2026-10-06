import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { getPublicOrder } from "./public.service.js";

export const publicRouter = Router();

publicRouter.get("/orders/:token", asyncHandler(async (req, res) => {
  res.json(await getPublicOrder(req.params.token));
}));
