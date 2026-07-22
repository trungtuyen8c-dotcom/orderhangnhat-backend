import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { minio, BUCKET } from "../../minio.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { parseSheetId, readInvoiceTaxRows, readInvoiceTaxRowsFromExcel } from "../../utils/gsheets.js";

export const shipmentsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
shipmentsRouter.use(authenticate);

// Upload chứng từ GA (invoice/packing/ingredient/purchase_invoice/tax) qua backend -> MinIO
shipmentsRouter.post("/documents", authorize("shipments.upload_doc"), upload.single("file"), async (req, res) => {
  const file = req.file;
  const { type, orderId, invoiceDate } = req.body as { type?: string; orderId?: string; invoiceDate?: string };
  if (!file || !type) return res.status(400).json({ error: "BAD_REQUEST" });

  const key = `documents/${type}/${uuid()}-${file.originalname}`;
  await minio.putObject(BUCKET, key, file.buffer, file.size, { "Content-Type": file.mimetype });
  const doc = await prisma.document.create({
    data: { id: uuid(), type, objectKey: key, orderId: orderId || null, invoiceDate: invoiceDate ? new Date(invoiceDate) : null, uploadedBy: req.user!.id },
  });
  await logAudit({ actorId: req.user!.id, targetId: doc.id, action: "document.uploaded", metadata: { type } });
  res.status(201).json(doc);
});

// Link sheet nháp kho ("invoice test") dùng để đọc dòng tô vàng (cần lấy thuế) - lưu trong AppConfig
shipmentsRouter.get("/tax-config", authorize("system.manage_settings"), async (req, res) => {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "invoice_tax_sheet_id" } });
  res.json({ sheetUrl: cfg?.value ?? "", sheetId: cfg?.value ? parseSheetId(cfg.value) : null });
});
const taxCfgSchema = z.object({ sheetUrl: z.string().nullable().optional() });
shipmentsRouter.put("/tax-config", authorize("system.manage_settings"), async (req, res) => {
  const p = taxCfgSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const url = (p.data.sheetUrl ?? "").trim();
  if (url && !parseSheetId(url)) return res.status(400).json({ error: "BAD_URL", message: "Link Google Sheet không hợp lệ" });
  await prisma.appConfig.upsert({ where: { key: "invoice_tax_sheet_id" }, update: { value: url }, create: { key: "invoice_tax_sheet_id", value: url } });
  await logAudit({ actorId: req.user!.id, action: "shipments.tax_config_set" });
  res.json({ sheetUrl: url, sheetId: url ? parseSheetId(url) : null });
});

type TaxSuggestion = { orderCode: string; customerName: string | null; nick: string | null; similarity: number };
type TaxRowOut = { trackingId: string | null; trackingCode: string | null; itemName: string; priceJpy: number | null; orderCode: string | null; customerName: string | null; nick: string | null; taxCollected: boolean; unmatched: boolean; purchaseUrl: string | null; packedAt: string | null; note: string | null; bill: string | null; matchedBy: "tracking" | "name" | null; suggestion: TaxSuggestion | null };

// Tracking.url gần như luôn trống (kho Nhật ít điền tay) -> lấy link mua hàng thật từ OrderItem.url (sync sẵn từ
// cột "LINK đặt" trên sheet đơn hàng). Ưu tiên item có tên khớp gần đúng với tên hàng quét được trên dòng vàng.
function pickPurchaseUrl(items: { name: string; url: string | null }[], itemName: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = norm(itemName);
  const matched = target && items.find((i) => i.url && target.includes(norm(i.name)));
  if (matched) return matched.url;
  return items.find((i) => i.url)?.url ?? null;
}

const normName = (s: string) => s.replace(/\s+/g, "").toLowerCase();
// Khớp theo tên khi dòng vàng không có mã tracking (vd file hải quan GB.xxx chỉ có tên hàng, không mang tracking).
// Kém chắc chắn hơn khớp mã (nhiều đơn có thể trùng/gần giống tên) - FE đánh dấu riêng để nhân viên xác nhận lại.
function findByName<T extends { name: string }>(candidates: T[], itemName: string): T | null {
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

// Khớp danh sách dòng vàng (đọc từ Google Sheet hoặc từ file Excel upload) với bảng Tracking - dùng chung
// cho cả /tax-rows (nguồn sheet cấu hình sẵn) và /documents/scan-tax (nguồn file upload trực tiếp).
async function matchTaxRows(sheetRows: { trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[]): Promise<TaxRowOut[]> {
  if (!sheetRows.length) return [];
  const codeRows = sheetRows.filter((r) => r.trackingCode);
  const nameRows = sheetRows.filter((r) => !r.trackingCode);
  const codes = [...new Set(codeRows.map((r) => r.trackingCode!))];
  const [trks, notes, nameCandidates] = await Promise.all([
    prisma.tracking.findMany({
      where: { code: { in: codes } },
      include: { order: { include: { customer: { select: { name: true } }, items: true } } },
    }),
    prisma.taxRowNote.findMany({ where: { trackingCode: { in: codes } } }),
    nameRows.length
      ? prisma.orderItem.findMany({
          where: { order: { status: { not: "cancelled" }, createdAt: { gte: new Date(Date.now() - 180 * 86400000) } } },
          select: { name: true, order: { select: { code: true, nick: true, customer: { select: { name: true } } } } },
          take: 5000,
        })
      : Promise.resolve([]),
  ]);
  // Đánh dấu needsTax=true cho tracking khớp được (không tự tắt lại nếu dòng hết vàng sau này - giữ lịch sử đã từng cần lấy thuế).
  const toFlag = trks.filter((t) => !t.needsTax).map((t) => t.id);
  if (toFlag.length) await prisma.tracking.updateMany({ where: { id: { in: toFlag } }, data: { needsTax: true } });
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

  const nameOut: TaxRowOut[] = nameRows.map((r): TaxRowOut => {
    const hit = findByName(nameCandidates, r.itemName);
    if (!hit) {
      const sug = suggestByName(nameCandidates, r.itemName);
      const suggestion: TaxSuggestion | null = sug
        ? { orderCode: sug.item.order.code, customerName: sug.item.order.customer?.name ?? null, nick: sug.item.order.nick ?? null, similarity: Math.round(sug.similarity * 100) }
        : null;
      return { trackingId: null, trackingCode: null, itemName: r.itemName, priceJpy: r.price, orderCode: null, customerName: null, nick: null, taxCollected: false, unmatched: true, purchaseUrl: null, packedAt: null, note: null, bill: r.bill, matchedBy: null, suggestion };
    }
    return {
      trackingId: null, trackingCode: null, itemName: r.itemName, priceJpy: r.price,
      orderCode: hit.order.code, customerName: hit.order.customer?.name ?? null, nick: hit.order.nick ?? null,
      taxCollected: false, unmatched: false, purchaseUrl: null, packedAt: null, note: null, bill: r.bill, matchedBy: "name", suggestion: null,
    };
  });

  return [...codeOut, ...nameOut];
}

// Ghi chú thủ công theo mã tracking (vd mã seller ghi sai, đang chờ mở hàng xác minh) - không tự gán đơn.
const noteSchema = z.object({ note: z.string().nullable() });
shipmentsRouter.put("/tax-rows/:code/note", authorize("trackings.update"), async (req, res) => {
  const p = noteSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const code = req.params.code;
  const note = (p.data.note ?? "").trim();
  if (!note) { await prisma.taxRowNote.deleteMany({ where: { trackingCode: code } }); return res.json({ trackingCode: code, note: null }); }
  const row = await prisma.taxRowNote.upsert({
    where: { trackingCode: code },
    update: { note, updatedBy: req.user!.id },
    create: { trackingCode: code, note, updatedBy: req.user!.id },
  });
  res.json({ trackingCode: row.trackingCode, note: row.note });
});

// Các dòng đang tô vàng trên sheet nháp kho ("cần lấy thuế") - khớp theo Mã TRACKING với hệ thống.
shipmentsRouter.get("/tax-rows", authorize("shipments.list"), async (req, res) => {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "invoice_tax_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return res.json([]);
  const sheetRows = await readInvoiceTaxRows(sid);
  res.json(await matchTaxRows(sheetRows));
});

// Quét file Excel chứng từ GA (loại "tax") upload trực tiếp -> đọc dòng vàng + khớp Tracking, KHÔNG lưu file.
shipmentsRouter.post("/documents/scan-tax", authorize("shipments.upload_doc"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "BAD_REQUEST" });
  let sheetRows: { trackingCode: string | null; itemName: string; price: number | null; bill: string | null }[];
  try { sheetRows = await readInvoiceTaxRowsFromExcel(req.file.buffer); }
  catch { return res.status(400).json({ error: "BAD_FILE", message: "Không đọc được file Excel" }); }
  res.json(await matchTaxRows(sheetRows));
});

shipmentsRouter.get("/documents", authorize("shipments.list"), async (req, res) => {
  const where: any = {};
  if (req.query.orderId) where.orderId = String(req.query.orderId);
  const rows = await prisma.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  res.json(rows);
});

// Tải file: backend stream từ MinIO (không expose MinIO ra ngoài)
shipmentsRouter.get("/documents/:id/download", authorize("shipments.list"), async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: "NOT_FOUND" });
  try {
    const stream = await minio.getObject(BUCKET, doc.objectKey);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.objectKey.split("/").pop()}"`);
    stream.pipe(res);
  } catch {
    res.status(500).json({ error: "DOWNLOAD_FAILED" });
  }
});
