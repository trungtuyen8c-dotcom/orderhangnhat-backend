import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../app/errors/AppError.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import {
  DOCUMENT_KINDS, TAX_SCAN_KINDS, checkFile, contentDisposition, decodeOriginalName, documentUpload,
  readHead, removeTempFile, sanitizeFilename, taxScanUpload,
} from "./documentUpload.js";
import * as svc from "./shipments.service.js";

export const shipmentsRouter = Router();
shipmentsRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });
const monthOr400 = (req: Request) => {
  const range = svc.parseMonth(req.query.month);
  if (!range) throw new AppError("BAD_REQUEST", 400);
  return range;
};
const fileRejected = (c: { reason: "TYPE" | "SIZE"; maxBytes?: number }) =>
  c.reason === "SIZE"
    ? new AppError("FILE_TOO_LARGE", 413, `File quá lớn (tối đa ${Math.round((c.maxBytes ?? 0) / 1024 / 1024)}MB)`)
    : new AppError("BAD_FILE", 400, "Loại file không được hỗ trợ");

// Upload chứng từ GA (invoice/packing/ingredient/purchase_invoice/tax) qua backend -> MinIO
shipmentsRouter.post("/documents", authorize("shipments.upload_doc"), documentUpload, asyncHandler(async (req, res) => {
  const file = req.file;
  try {
    const { type, orderId, invoiceDate } = req.body as { type?: string; orderId?: string; invoiceDate?: string };
    if (!file || !type) throw new AppError("BAD_REQUEST", 400);
    const safeName = sanitizeFilename(decodeOriginalName(file.originalname));
    const check = checkFile(safeName, await readHead(file.path), file.size, DOCUMENT_KINDS);
    if (!check.ok) throw fileRejected(check);
    const doc = await svc.uploadDocument({ path: file.path, size: file.size, safeName, mime: check.mime }, { type, orderId, invoiceDate }, actor(req));
    res.status(201).json(doc);
  } finally {
    await removeTempFile(file?.path);
  }
}));

// Link sheet nháp kho ("invoice test") dùng để đọc dòng tô vàng (cần lấy thuế) - lưu trong AppConfig
shipmentsRouter.get("/tax-config", authorize("system.manage_settings"), asyncHandler(async (_req, res) => {
  res.json(await svc.getTaxConfig());
}));

const taxCfgSchema = z.object({ sheetUrl: z.string().nullable().optional() });
shipmentsRouter.put("/tax-config", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  const body = parseOr400(taxCfgSchema, req.body);
  res.json(await svc.setTaxConfig(body.sheetUrl, actor(req)));
}));

const noteSchema = z.object({ note: z.string().nullable().optional(), taxCollected: z.boolean().optional() });
shipmentsRouter.put("/tax-rows/:code/note", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(noteSchema, req.body);
  res.json(await svc.setTaxRowNote(req.params.code, body, actor(req)));
}));

shipmentsRouter.get("/tax-audit", authorize("shipments.list"), asyncHandler(async (req, res) => {
  res.json(await svc.taxAudit(monthOr400(req)));
}));

// Tick "đã xử lý" (đã đi thêm tracking vào sheet nháp kho) - ẩn khỏi danh sách "chưa lên thuế" dù needsTax
// vẫn chưa tự bật (chờ lần quét sheet sau). Bỏ tick lại được nếu tick nhầm.
const auditDismissSchema = z.object({ dismissed: z.boolean() });
shipmentsRouter.patch("/tax-audit/:trackingId", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(auditDismissSchema, req.body);
  res.json(await svc.setTaxAuditDismissed(req.params.trackingId, body.dismissed));
}));

shipmentsRouter.get("/invoice-checklist", authorize("shipments.list"), asyncHandler(async (req, res) => {
  res.json(await svc.invoiceChecklist(monthOr400(req)));
}));

const invoiceDoneSchema = z.object({ done: z.boolean() });
shipmentsRouter.put("/invoice-checklist/:key", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(invoiceDoneSchema, req.body);
  res.json(await svc.setInvoiceDone(decodeURIComponent(req.params.key), body.done, actor(req)));
}));

shipmentsRouter.get("/tax-rows", authorize("shipments.list"), asyncHandler(async (_req, res) => {
  res.json(await svc.listTaxRows({ persist: true }));
}));

// Quét file Excel chứng từ GA (loại "tax") upload trực tiếp -> đọc dòng vàng + khớp Tracking, KHÔNG lưu file.
shipmentsRouter.post("/documents/scan-tax", authorize("shipments.upload_doc"), taxScanUpload, asyncHandler(async (req, res) => {
  const file = req.file;
  if (!file) throw new AppError("BAD_REQUEST", 400);
  const check = checkFile(decodeOriginalName(file.originalname), file.buffer.subarray(0, 1024), file.size, TAX_SCAN_KINDS);
  // Sai loại -> cùng body như khi exceljs không đọc được file (FE chỉ hiện "Quét file thất bại").
  if (!check.ok) throw check.reason === "SIZE" ? fileRejected(check) : new AppError("BAD_FILE", 400, "Không đọc được file Excel");
  res.json(await svc.scanTaxFile(file.buffer));
}));

shipmentsRouter.get("/documents", authorize("shipments.list"), asyncHandler(async (req, res) => {
  res.json(await svc.listDocuments(req.query.orderId ? String(req.query.orderId) : undefined));
}));

// Tải file: backend stream từ MinIO (không expose MinIO ra ngoài)
shipmentsRouter.get("/documents/:id/download", authorize("shipments.list"), asyncHandler(async (req, res) => {
  const { filename, stream } = await svc.openDocument(req.params.id);
  res.setHeader("Content-Disposition", contentDisposition(filename));
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}));
