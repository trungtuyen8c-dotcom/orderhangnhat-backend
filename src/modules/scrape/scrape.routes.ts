import { Router } from "express";
import { handle } from "../../app/http/legacyError.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { scrapeProduct } from "./scrape.service.js";

export const scrapeRouter = Router();
scrapeRouter.use(authenticate);

scrapeRouter.get("/", handle(async (req, res) => {
  res.json(await scrapeProduct(String(req.query.url || "")));
}));
