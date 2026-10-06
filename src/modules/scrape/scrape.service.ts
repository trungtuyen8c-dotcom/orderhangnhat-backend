import { LegacyError } from "../../app/http/legacyError.js";
import { logger } from "../../infrastructure/logger.js";
import { isAllowedUrl, scrapeItem, type ScrapedItem } from "../../integrations/marketplace/scrape.js";

// Lấy tên + giá ¥ từ link sản phẩm (Yahoo Flea/Auctions, Mercari). Dùng cho đơn + tracking.
export async function scrapeProduct(url: string): Promise<ScrapedItem> {
  if (!isAllowedUrl(url)) throw new LegacyError(400, "BAD_URL", "Chỉ hỗ trợ link Yahoo / Mercari");
  let data: ScrapedItem;
  try {
    data = await scrapeItem(url);
  } catch (e) {
    logger.warn({ url, err: (e as Error).message }, "scrape_fetch_failed");
    throw new LegacyError(502, "FETCH_FAILED", "Không tải được trang");
  }
  if (!data.name && data.priceJpy == null) throw new LegacyError(422, "NOT_FOUND", "Không lấy được tên/giá, nhập tay");
  return data;
}
