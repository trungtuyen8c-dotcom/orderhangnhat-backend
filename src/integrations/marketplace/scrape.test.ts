import { describe, it, expect, vi, afterEach } from "vitest";
import { detectMarketplace, isAllowedUrl, scrapeItem } from "./scrape.js";

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

describe("isAllowedUrl", () => {
  it.each([
    ["yahooHttps", "https://auctions.yahoo.co.jp/x", true],
    ["mercariHttp", "http://jp.mercari.com/item/1", true],
    ["ftpProtocol", "ftp://auctions.yahoo.co.jp/x", false],
    ["lookalikeSuffixDomain", "https://evilyahoo.co.jp.attacker.com/x", false],
    ["prefixWithoutDot", "https://notmercari.com/x", false],
    ["localhost", "http://127.0.0.1/admin", false],
    ["garbage", "not a url", false],
  ])("isAllowedUrl_%s_returns%s", (_name, url, expected) => {
    expect(isAllowedUrl(url)).toBe(expected);
  });
});

describe("scrapeItem", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubHtml = (html: string) => {
    const f = vi.fn().mockResolvedValue({ text: async () => html });
    vi.stubGlobal("fetch", f);
    return f;
  };

  it("scrapeItem_jsonLdProduct_returnsNameAndRoundedPrice", async () => {
    stubHtml(`<script type="application/ld+json">{"@type":"Product","name":"Áo khoác ｜ メルカリ","offers":{"price":"1234.6"}}</script>`);
    expect(await scrapeItem("https://jp.mercari.com/item/1")).toEqual({ name: "Áo khoác", priceJpy: 1235 });
  });

  it("scrapeItem_jsonLdArrayWithOffersArray_usesFirstProductOffer", async () => {
    stubHtml(`<script type="application/ld+json">[{"@type":"BreadcrumbList"},{"@type":"Product","name":"Bag","offers":[{"price":500},{"price":900}]}]</script>`);
    expect(await scrapeItem("https://jp.mercari.com/item/1")).toEqual({ name: "Bag", priceJpy: 500 });
  });

  it("scrapeItem_invalidJsonLd_fallsBackToOgTitleAndPriceField", async () => {
    stubHtml(`<script type="application/ld+json">{broken</script><meta property="og:title" content="Giày | Yahoo"><script>{"price":"3000"}</script>`);
    expect(await scrapeItem("https://auctions.yahoo.co.jp/x")).toEqual({ name: "Giày", priceJpy: 3000 });
  });

  it("scrapeItem_ogTitleContentBeforeProperty_stillParsed", async () => {
    stubHtml(`<meta content="Mũ len" property="og:title">`);
    expect((await scrapeItem("https://auctions.yahoo.co.jp/x")).name).toBe("Mũ len");
  });

  it("scrapeItem_nextDataProductName_decodesJsonEscapes", async () => {
    stubHtml(`<script id="__NEXT_DATA__">{"productName":"Caf\\u00e9 \\"Mug\\"","price":1500}</script>`);
    expect(await scrapeItem("https://auctions.yahoo.co.jp/x")).toEqual({ name: 'Café "Mug"', priceJpy: 1500 });
  });

  it("scrapeItem_noRecognizableData_returnsNulls", async () => {
    stubHtml(`<html><body>hello "price": 5</body></html>`);
    expect(await scrapeItem("https://auctions.yahoo.co.jp/x")).toEqual({ name: null, priceJpy: null });
  });

  it("scrapeItem_fetch_sendsBrowserUserAgentAndJapaneseLanguage", async () => {
    const f = stubHtml("");
    await scrapeItem("https://auctions.yahoo.co.jp/x");
    expect(f.mock.calls[0][1].headers).toMatchObject({ "Accept-Language": "ja,en;q=0.8", "User-Agent": expect.stringContaining("Mozilla/5.0") });
  });

  it("scrapeItem_fetchRejects_propagatesError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("aborted")));
    await expect(scrapeItem("https://auctions.yahoo.co.jp/x")).rejects.toThrow("aborted");
  });
});
