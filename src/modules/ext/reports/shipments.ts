// Report shipments_* - copy logic từ shipments.routes.ts (đọc-only, không import file đó).
// Khác bản gốc: matchTaxRows ở đây KHÔNG ghi DB (bỏ 2 đoạn updateMany needsTax + taxRowNote.createMany
// của bản gốc) - module ext chỉ đọc, không được có side-effect ẩn khi AI gọi 1 GET.
import { prisma } from "../../../db.js";
import { parseSheetId, readInvoiceTaxRows } from "../../../utils/gsheets.js";
import { vnMonthRange } from "../helpers.js";

type TaxSuggestion = { orderCode: string; customerName: string | null; nick: string | null; similarity: number };
type TaxRowOut = { trackingId: string | null; trackingCode: string | null; itemName: string; priceJpy: number | null; orderCode: string | null; customerName: string | null; nick: string | null; taxCollected: boolean; unmatched: boolean; purchaseUrl: string | null; packedAt: string | null; note: string | null; bill: string | null; matchedBy: "tracking" | "name" | null; suggestion: TaxSuggestion | null };

function pickPurchaseUrl(items: { name: string; url: string | null }[], itemName: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = norm(itemName);
  const matched = target && items.find((i) => i.url && target.includes(norm(i.name)));
  if (matched) return matched.url;
  return items.find((i) => i.url)?.url ?? null;
}
const normName = (s: string) => s.replace(/\s+/g, "").toLowerCase();
function findByName<T extends { name: string }>(candidates: T[], itemName: string): T | null {
  const target = normName(itemName);
  if (!target) return null;
  return candidates.find((i) => { const n = normName(i.name); return n === target || n.includes(target) || target.includes(n); }) ?? null;
}
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}
const FUZZY_THRESHOLD = 0.5;
function suggestByName<T extends { name: string }>(candidates: T[], itemName: string): { item: T; similarity: number } | null {
  const target = normName(itemName);
  if (target.length < 4) return null;
  let best: { item: T; similarity: number } | null = null;
  for (const c of candidates) {
    const sim = diceSimilarity(target, normName(c.name));
    if (sim >= FUZZY_THRESHOLD && (!best || sim > best.similarity)) best = { item: c, similarity: sim };
  }
  return best;
}

async function matchTaxRowsReadOnly(sheetRows: { trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[]): Promise<TaxRowOut[]> {
  if (!sheetRows.length) return [];
  const codeRows = sheetRows.filter((r) => r.trackingCode);
  const nameRows = sheetRows.filter((r) => !r.trackingCode);
  const codes = [...new Set(codeRows.map((r) => r.trackingCode!))];
  const [trks, notes, nameCandidates] = await Promise.all([
    prisma.tracking.findMany({ where: { code: { in: codes } }, include: { order: { include: { customer: { select: { name: true } }, items: true } } } }),
    prisma.taxRowNote.findMany({ where: { trackingCode: { in: codes } } }),
    nameRows.length
      ? prisma.orderItem.findMany({
          where: { order: { status: { not: "cancelled" }, createdAt: { gte: new Date(Date.now() - 180 * 86400000) } } },
          select: { name: true, order: { select: { code: true, nick: true, customer: { select: { name: true } }, items: { select: { name: true, url: true } } } } },
          take: 5000,
        })
      : Promise.resolve([]),
  ]);
  const byCode = new Map<string, typeof trks>();
  for (const t of trks) { const arr = byCode.get(t.code) ?? []; arr.push(t); byCode.set(t.code, arr); }
  const noteByCode = new Map(notes.map((n) => [n.trackingCode, n.note]));

  const codeOut: TaxRowOut[] = codeRows.flatMap((r): TaxRowOut[] => {
    const code = r.trackingCode!;
    const note = noteByCode.get(code) ?? null;
    const matches = byCode.get(code) ?? [];
    if (!matches.length) {
      return [{ trackingId: null, trackingCode: code, itemName: r.itemName, priceJpy: r.price, orderCode: null, customerName: null, nick: null, taxCollected: false, unmatched: true, purchaseUrl: null, packedAt: null, note, bill: r.bill, matchedBy: null, suggestion: null }];
    }
    return matches.map((t) => ({
      trackingId: t.id, trackingCode: t.code, itemName: r.itemName, priceJpy: r.price,
      orderCode: t.order?.code ?? null, customerName: t.order?.customer?.name ?? null, nick: t.order?.nick ?? null,
      taxCollected: t.taxCollected, unmatched: false,
      purchaseUrl: pickPurchaseUrl(t.order?.items ?? [], r.itemName), packedAt: t.packedAt ? t.packedAt.toISOString() : null, note, bill: r.bill, matchedBy: "tracking", suggestion: null,
    }));
  });

  const claimedOrderCodes = new Set(codeOut.filter((o) => !o.unmatched && o.orderCode).map((o) => o.orderCode!));
  const nameOut: TaxRowOut[] = [];
  for (const r of nameRows) {
    const available = nameCandidates.filter((c) => !claimedOrderCodes.has(c.order.code));
    const hit = findByName(available, r.itemName);
    if (!hit) {
      const sug = suggestByName(available, r.itemName);
      const suggestion: TaxSuggestion | null = sug
        ? { orderCode: sug.item.order.code, customerName: sug.item.order.customer?.name ?? null, nick: sug.item.order.nick ?? null, similarity: Math.round(sug.similarity * 100) }
        : null;
      nameOut.push({ trackingId: null, trackingCode: null, itemName: r.itemName, priceJpy: r.price, orderCode: null, customerName: null, nick: null, taxCollected: false, unmatched: true, purchaseUrl: null, packedAt: null, note: null, bill: r.bill, matchedBy: null, suggestion });
      continue;
    }
    claimedOrderCodes.add(hit.order.code);
    nameOut.push({
      trackingId: null, trackingCode: null, itemName: r.itemName, priceJpy: r.price,
      orderCode: hit.order.code, customerName: hit.order.customer?.name ?? null, nick: hit.order.nick ?? null,
      taxCollected: false, unmatched: false, purchaseUrl: pickPurchaseUrl(hit.order.items, r.itemName), packedAt: null, note: null, bill: r.bill, matchedBy: "name", suggestion: null,
    });
  }
  const nameNoteKeys = nameOut.map((r) => `name:${r.bill ?? ""}:${r.orderCode ?? ""}:${r.itemName}`);
  const nameNotes = nameNoteKeys.length ? await prisma.taxRowNote.findMany({ where: { trackingCode: { in: nameNoteKeys } } }) : [];
  const nameNoteByKey = new Map(nameNotes.map((n) => [n.trackingCode, n]));
  for (const r of nameOut) {
    const found = nameNoteByKey.get(`name:${r.bill ?? ""}:${r.orderCode ?? ""}:${r.itemName}`);
    if (found) { r.note = found.note || null; r.taxCollected = found.taxCollected; }
  }
  return [...codeOut, ...nameOut];
}

async function buildExtraNeedsTaxRows(shownTrackingIds: Set<string>): Promise<TaxRowOut[]> {
  const trks = await prisma.tracking.findMany({
    where: { needsTax: true, taxCollected: false, orderId: { not: null }, id: { notIn: [...shownTrackingIds] } },
    include: { order: { include: { customer: { select: { name: true } }, items: true } }, carton: true },
  });
  if (!trks.length) return [];
  const codes = [...new Set(trks.map((t) => t.code))];
  const notes = await prisma.taxRowNote.findMany({ where: { trackingCode: { in: codes } } });
  const noteByCode = new Map(notes.map((n) => [n.trackingCode, n.note]));
  return trks.map((t): TaxRowOut => {
    const items = t.order?.items ?? [];
    const itemName = items.map((i) => i.name).join(" + ") || "(chưa quét chi tiết)";
    const price = items.length ? items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy) + (i.shipJpy != null ? Number(i.shipJpy) : 0), 0) : null;
    return {
      trackingId: t.id, trackingCode: t.code, itemName, priceJpy: price,
      orderCode: t.order?.code ?? null, customerName: t.order?.customer?.name ?? null, nick: t.order?.nick ?? null,
      taxCollected: t.taxCollected, unmatched: !t.order, purchaseUrl: items.length ? pickPurchaseUrl(items, itemName) : null,
      packedAt: t.packedAt ? t.packedAt.toISOString() : null, note: noteByCode.get(t.code) ?? null,
      bill: t.carton ? (t.carton.code.split(" ")[0] || t.carton.code) : null, matchedBy: t.order ? "tracking" : null, suggestion: null,
    };
  });
}

export async function shipments_tax_audit(params: { month?: string }) {
  const m = /^(\d{4})-(\d{2})$/.exec(params.month ?? "");
  if (!m) throw Object.assign(new Error("month phải dạng YYYY-MM"), { code: "BAD_REQUEST" });
  const { start, end } = vnMonthRange(`${m[1]}-${m[2]}`);
  const trks = await prisma.tracking.findMany({
    where: { packedAt: { gte: start, lt: end }, order: { status: { not: "cancelled" } } },
    select: { id: true, code: true, packedAt: true, needsTax: true, taxCollected: true, taxAuditDismissed: true, order: { select: { code: true, nick: true, customer: { select: { name: true } } } } },
    orderBy: { packedAt: "asc" },
  });
  const declaredCollected = trks.filter((t) => t.needsTax && t.taxCollected).length;
  const declaredPending = trks.filter((t) => t.needsTax && !t.taxCollected).length;
  const notDeclared = trks.filter((t) => !t.needsTax && !t.taxAuditDismissed);
  return {
    total: trks.length, declaredCollected, declaredPending,
    notDeclared: notDeclared.map((t) => ({
      trackingId: t.id, trackingCode: t.code, orderCode: t.order?.code ?? null,
      customerName: t.order?.customer?.name ?? null, nick: t.order?.nick ?? null,
      packedAt: t.packedAt ? t.packedAt.toISOString() : null,
    })),
  };
}

export async function shipments_invoice_checklist(params: { month?: string }) {
  const m = /^(\d{4})-(\d{2})$/.exec(params.month ?? "");
  if (!m) throw Object.assign(new Error("month phải dạng YYYY-MM"), { code: "BAD_REQUEST" });
  const { start, end } = vnMonthRange(`${m[1]}-${m[2]}`);
  const cartons = await prisma.carton.findMany({ where: { packedDate: { gte: start, lt: end } }, select: { code: true, packedDate: true, trackings: { select: { id: true } } } });
  const groups = new Map<string, { date: string; bill: string; cartonCount: number; trackingCount: number }>();
  for (const c of cartons) {
    if (!c.packedDate) continue;
    const bill = c.code.split(" ")[0] || c.code;
    const date = c.packedDate.toISOString().slice(0, 10);
    const key = `${date}|${bill}`;
    const g = groups.get(key) ?? { date, bill, cartonCount: 0, trackingCount: 0 };
    g.cartonCount += 1;
    g.trackingCount += c.trackings.length;
    groups.set(key, g);
  }
  const keys = [...groups.keys()];
  const statuses = keys.length ? await prisma.billInvoiceStatus.findMany({ where: { key: { in: keys } } }) : [];
  const doneSet = new Set(statuses.filter((s) => s.done).map((s) => s.key));
  return [...groups.entries()]
    .map(([key, g]) => ({ key, ...g, done: doneSet.has(key) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.bill.localeCompare(b.bill));
}

export async function shipments_tax_rows() {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "invoice_tax_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  const sheetRows = sid ? await readInvoiceTaxRows(sid) : [];
  const rows = await matchTaxRowsReadOnly(sheetRows);
  const shownIds = new Set(rows.filter((r) => r.trackingId).map((r) => r.trackingId!));
  return [...rows, ...(await buildExtraNeedsTaxRows(shownIds))];
}

export function shipments_documents(params: { orderId?: string }) {
  return prisma.document.findMany({
    where: params.orderId ? { orderId: params.orderId } : undefined,
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, type: true, orderId: true, invoiceDate: true, createdAt: true },
  });
}
