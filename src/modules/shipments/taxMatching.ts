// Hàm thuần dùng để khớp dòng vàng "cần lấy thuế" với đơn/tracking - không đụng DB.

export type TaxSuggestion = { orderCode: string; customerName: string | null; nick: string | null; similarity: number };
export type TaxRowOut = { trackingId: string | null; trackingCode: string | null; itemName: string; priceJpy: number | null; orderCode: string | null; customerName: string | null; nick: string | null; taxCollected: boolean; unmatched: boolean; purchaseUrl: string | null; packedAt: string | null; note: string | null; bill: string | null; matchedBy: "tracking" | "name" | null; suggestion: TaxSuggestion | null };
export type SheetTaxRow = { trackingCode: string | null; itemName: string; price: number | null; bill: string | null };

// Tracking.url gần như luôn trống (kho Nhật ít điền tay) -> lấy link mua hàng thật từ OrderItem.url (sync sẵn từ
// cột "LINK đặt" trên sheet đơn hàng). Ưu tiên item có tên khớp gần đúng với tên hàng quét được trên dòng vàng.
export function pickPurchaseUrl(items: { name: string; url: string | null }[], itemName: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = norm(itemName);
  const matched = target && items.find((i) => i.url && target.includes(norm(i.name)));
  if (matched) return matched.url;
  return items.find((i) => i.url)?.url ?? null;
}

// Khóa lưu Ghi chú/"Đã lấy thuế" cho dòng khớp theo tên - phải khớp đúng công thức taxRowKey ở FE.
export function nameRowKey(bill: string | null, orderCode: string | null, itemName: string): string {
  return `name:${bill ?? ""}:${orderCode ?? ""}:${itemName}`;
}

export const normName = (s: string) => s.replace(/\s+/g, "").toLowerCase();
// Khớp theo tên khi dòng vàng không có mã tracking (vd file hải quan GB.xxx chỉ có tên hàng, không mang tracking).
// Kém chắc chắn hơn khớp mã (nhiều đơn có thể trùng/gần giống tên) - FE đánh dấu riêng để nhân viên xác nhận lại.
export function findByName<T extends { name: string }>(candidates: T[], itemName: string): T | null {
  const target = normName(itemName);
  if (!target) return null;
  return candidates.find((i) => { const n = normName(i.name); return n === target || n.includes(target) || target.includes(n); }) ?? null;
}

// Gợi ý "gần đúng" khi không khớp chính xác/chứa nhau - Dice coefficient trên bigram ký tự, đủ rẻ để
// so với hàng nghìn OrderItem trong 1 request. Không tự áp dụng - chỉ gợi ý, nhân viên bấm xác nhận ở FE.
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
export function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
const FUZZY_THRESHOLD = 0.5;
export function suggestByName<T extends { name: string }>(candidates: T[], itemName: string): { item: T; similarity: number } | null {
  const target = normName(itemName);
  if (target.length < 4) return null;
  let best: { item: T; similarity: number } | null = null;
  for (const c of candidates) {
    const sim = diceSimilarity(target, normName(c.name));
    if (sim >= FUZZY_THRESHOLD && (!best || sim > best.similarity)) best = { item: c, similarity: sim };
  }
  return best;
}

// Bill = phần đầu mã kiện "BILL Thùng" (vd "GE 1" -> "GE").
export const billOf = (cartonCode: string) => cartonCode.split(" ")[0] || cartonCode;
