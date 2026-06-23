import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate.js";
import { scrapeItem, isAllowedUrl } from "../../utils/scrape.js";

export const scrapeRouter = Router();
scrapeRouter.use(authenticate);

// Lấy tên + giá ¥ từ link sản phẩm (Yahoo Flea/Auctions, Mercari). Dùng cho đơn + tracking.
scrapeRouter.get("/", async (req, res) => {
  const url = String(req.query.url || "");
  if (!isAllowedUrl(url)) return res.status(400).json({ error: "BAD_URL", message: "Chỉ hỗ trợ link Yahoo / Mercari" });
  try {
    const data = await scrapeItem(url);
    if (!data.name && data.priceJpy == null) return res.status(422).json({ error: "NOT_FOUND", message: "Không lấy được tên/giá, nhập tay" });
    res.json(data);
  } catch {
    res.status(502).json({ error: "FETCH_FAILED", message: "Không tải được trang" });
  }
});
