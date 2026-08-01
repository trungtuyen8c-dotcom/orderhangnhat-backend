import { describe, it, expect } from "vitest";
import { detectMarketplace } from "./scrape.js";

describe("detectMarketplace", () => {
  it("detectMarketplace_yahooCoJpUrl_returnsYahoo", () => {
    expect(detectMarketplace("https://page.auctions.yahoo.co.jp/item/1")).toBe("yahoo");
  });

  it("detectMarketplace_mercariComUrl_returnsMercari", () => {
    expect(detectMarketplace("https://www.mercari.com/item/2")).toBe("mercari");
  });

  it("detectMarketplace_mercariJpUrl_returnsMercari", () => {
    expect(detectMarketplace("https://item.mercari.jp/item/3")).toBe("mercari");
  });

  it("detectMarketplace_otherDomain_returnsNull", () => {
    expect(detectMarketplace("https://example.com/item/4")).toBeNull();
  });

  it("detectMarketplace_invalidUrl_returnsNullWithoutThrowing", () => {
    expect(() => detectMarketplace("not-a-url")).not.toThrow();
    expect(detectMarketplace("not-a-url")).toBeNull();
  });
});
