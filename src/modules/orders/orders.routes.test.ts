import { describe, it, expect } from "vitest";
import { findWrongMarketplaceUrl } from "./orders.routes.js";

describe("findWrongMarketplaceUrl", () => {
  it("findWrongMarketplaceUrl_sourceNotYahooOrMercari_returnsNull", () => {
    const items = [{ url: "https://www.mercari.com/item/1" }];
    expect(findWrongMarketplaceUrl("other", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_yahooSourceWithMercariItemUrl_returnsThatUrl", () => {
    const items = [{ url: "https://www.mercari.com/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBe("https://www.mercari.com/item/1");
  });

  it("findWrongMarketplaceUrl_yahooSourceWithMatchingYahooUrls_returnsNull", () => {
    const items = [{ url: "https://page.auctions.yahoo.co.jp/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_itemUrlNotFromEitherMarketplace_returnsNull", () => {
    const items = [{ url: "https://example.com/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });

  it("findWrongMarketplaceUrl_itemMissingUrl_skipsItem", () => {
    const items = [{}, { url: "https://page.auctions.yahoo.co.jp/item/1" }];
    expect(findWrongMarketplaceUrl("yahoo", items)).toBeNull();
  });
});
