import { AppError } from "../../app/errors/AppError.js";
import { logger } from "../../infrastructure/logger.js";
import { isAllowedUrl, scrapeItem, type ScrapedItem } from "../../integrations/marketplace/scrape.js";

// Lấy tên + giá ¥ từ link sản phẩm (Yahoo Flea/Auctions, Mercari). Dùng cho đơn + tracking.
export async function scrapeProduct(url: string): Promise<ScrapedItem> {
  if (!isAllowedUrl(url)) throw new AppError("BAD_URL", 400, "Chỉ hỗ trợ link Yahoo / Mercari");
  let data: ScrapedItem;
  try {
    data = await scrapeItem(url);
  } catch (e) {
    logger.warn({ url, err: (e as Error).message }, "scrape_fetch_failed");
    throw new AppError("FETCH_FAILED", 502, "Không tải được trang");
  }
  if (!data.name && data.priceJpy == null) throw new AppError("NOT_FOUND", 422, "Không lấy được tên/giá, nhập tay");
  return data;
}
