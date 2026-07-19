import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { minio, BUCKET } from "../../minio.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { parseSheetId, readInvoiceTaxRows } from "../../utils/gsheets.js";

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

// Các dòng đang tô vàng trên sheet nháp kho ("cần lấy thuế") - khớp theo Mã TRACKING với hệ thống.
shipmentsRouter.get("/tax-rows", authorize("shipments.list"), async (req, res) => {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "invoice_tax_sheet_id" } });
  const sid = cfg?.value ? parseSheetId(cfg.value) : null;
  if (!sid) return res.json([]);
  const sheetRows = await readInvoiceTaxRows(sid);
  const codes = [...new Set(sheetRows.map((r) => r.trackingCode))];
  if (!codes.length) return res.json([]);
  const trks = await prisma.tracking.findMany({
    where: { code: { in: codes } },
    include: { order: { include: { customer: { select: { name: true } }, items: true } } },
  });
  // Đánh dấu needsTax=true cho tracking khớp được (không tự tắt lại nếu dòng hết vàng sau này - giữ lịch sử đã từng cần lấy thuế).
  const toFlag = trks.filter((t) => !t.needsTax).map((t) => t.id);
  if (toFlag.length) await prisma.tracking.updateMany({ where: { id: { in: toFlag } }, data: { needsTax: true } });
  const byCode = new Map<string, typeof trks>();
  for (const t of trks) { const arr = byCode.get(t.code) ?? []; arr.push(t); byCode.set(t.code, arr); }
  type TaxRowOut = { trackingId: string | null; trackingCode: string; itemName: string; priceJpy: number | null; orderCode: string | null; customerName: string | null; taxCollected: boolean; unmatched: boolean };
  const out: TaxRowOut[] = sheetRows.flatMap((r): TaxRowOut[] => {
    const matches = byCode.get(r.trackingCode) ?? [];
    if (!matches.length) {
      return [{ trackingId: null, trackingCode: r.trackingCode, itemName: r.itemName, priceJpy: r.price, orderCode: null, customerName: null, taxCollected: false, unmatched: true }];
    }
    return matches.map((t) => ({
      trackingId: t.id, trackingCode: t.code, itemName: r.itemName, priceJpy: r.price,
      orderCode: t.order?.code ?? null, customerName: t.order?.customer?.name ?? null,
      taxCollected: t.taxCollected, unmatched: false,
    }));
  });
  res.json(out);
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
