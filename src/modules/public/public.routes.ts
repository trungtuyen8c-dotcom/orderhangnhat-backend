import { Router } from "express";
import { handle } from "../../app/http/legacyError.js";
import { getPublicOrder } from "./public.service.js";

export const publicRouter = Router();

publicRouter.get("/orders/:token", handle(async (req, res) => {
  res.json(await getPublicOrder(req.params.token));
}));
