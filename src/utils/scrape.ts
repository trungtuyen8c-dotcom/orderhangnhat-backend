export interface ScrapedItem { name: string | null; priceJpy: number | null; }

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Chỉ cho phép Yahoo / Mercari (tránh SSRF + đúng phạm vi)
const ALLOWED = [/(^|\.)yahoo\.co\.jp$/, /(^|\.)mercari\.com$/, /(^|\.)mercari\.jp$/];

export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return ALLOWED.some((re) => re.test(u.hostname));
  } catch { return false; }
}

export async function scrapeItem(url: string): Promise<ScrapedItem> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "ja,en;q=0.8" },
      redirect: "follow",
      signal: ctrl.signal,
    });
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  let name: string | null = null;
  let priceJpy: number | null = null;

  // 1. JSON-LD Product (Yahoo Flea/Auctions, Mercari đều có)
  for (const b of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
    let data: any;
    try { data = JSON.parse(b[1].trim()); } catch { continue; }
    for (const it of Array.isArray(data) ? data : [data]) {
      if (it && it["@type"] === "Product") {
        if (!name && typeof it.name === "string") name = it.name;
        const offer = Array.isArray(it.offers) ? it.offers[0] : it.offers;
        const p = offer?.price;
        if (priceJpy == null && p != null && !isNaN(Number(p))) priceJpy = Math.round(Number(p));
      }
    }
  }

  // 2. Fallback tên: og:title (bỏ phần sau ｜ / |)
  if (!name) {
    const m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (m) name = m[1];
  }
  // 2b. Yahoo Auctions mới render bằng __NEXT_DATA__ (không còn JSON-LD/og:title)
  if (!name) {
    const m = html.match(/"productName"\s*:\s*"((?:[^"\\]|\\.)*)"/) || html.match(/"title"\s*:\s*"((?:[^"\\]|\\.){3,200})"/);
    if (m) { try { name = JSON.parse('"' + m[1] + '"'); } catch { name = m[1]; } }
  }
  if (name) name = name.split(/[｜|]/)[0].trim();

  // 3. Fallback giá: tìm "price": trong __NEXT_DATA__ / JSON
  if (priceJpy == null) {
    const m = html.match(/"price"\s*:\s*"?(\d{2,})"?/);
    if (m) priceJpy = Math.round(Number(m[1]));
  }

  return { name, priceJpy };
}
