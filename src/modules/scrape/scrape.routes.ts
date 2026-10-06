import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { scrapeProduct } from "./scrape.service.js";

export const scrapeRouter = Router();
scrapeRouter.use(authenticate);

scrapeRouter.get("/", asyncHandler(async (req, res) => {
  res.json(await scrapeProduct(String(req.query.url || "")));
}));
