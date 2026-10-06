import { mkdirSync } from "fs";
import { open, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import multer from "multer";
import type { NextFunction, Request, RequestHandler, Response } from "express";

const MB = 1024 * 1024;

// Loại file cho phép (chứng từ GA: hóa đơn, packing list, bảng thành phần, hóa đơn mua hàng).
// Kiểm tra bằng nội dung (magic bytes) + đuôi file; MIME client gửi không được tin - lưu MIME do server xác định.
export type FileKind = { kind: string; exts: string[]; maxBytes: number; mime: (ext: string) => string; matches: (head: Buffer) => boolean };

const startsWith = (head: Buffer, sig: number[], offset = 0) => sig.every((b, i) => head[offset + i] === b);
const ascii = (head: Buffer, start: number, end: number) => head.subarray(start, end).toString("latin1");

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1", "heif"]);

const OFFICE_ZIP_MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const OFFICE_OLE_MIME: Record<string, string> = { xls: "application/vnd.ms-excel", doc: "application/msword", ppt: "application/vnd.ms-powerpoint" };

export const DOCUMENT_KINDS: FileKind[] = [
  { kind: "pdf", exts: ["pdf"], maxBytes: 50 * MB, mime: () => "application/pdf", matches: (h) => ascii(h, 0, 1024).includes("%PDF-") },
  { kind: "jpeg", exts: ["jpg", "jpeg", "jfif"], maxBytes: 25 * MB, mime: () => "image/jpeg", matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]) },
  { kind: "png", exts: ["png"], maxBytes: 25 * MB, mime: () => "image/png", matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { kind: "gif", exts: ["gif"], maxBytes: 25 * MB, mime: () => "image/gif", matches: (h) => ["GIF87a", "GIF89a"].includes(ascii(h, 0, 6)) },
  { kind: "webp", exts: ["webp"], maxBytes: 25 * MB, mime: () => "image/webp", matches: (h) => ascii(h, 0, 4) === "RIFF" && ascii(h, 8, 12) === "WEBP" },
  { kind: "bmp", exts: ["bmp"], maxBytes: 25 * MB, mime: () => "image/bmp", matches: (h) => ascii(h, 0, 2) === "BM" },
  {
    kind: "tiff", exts: ["tif", "tiff"], maxBytes: 25 * MB, mime: () => "image/tiff",
    matches: (h) => startsWith(h, [0x49, 0x49, 0x2a, 0x00]) || startsWith(h, [0x4d, 0x4d, 0x00, 0x2a]),
  },
  {
    kind: "heif", exts: ["heic", "heif"], maxBytes: 25 * MB, mime: (ext) => (ext === "heif" ? "image/heif" : "image/heic"),
    matches: (h) => ascii(h, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(h, 8, 12)),
  },
  { kind: "office-zip", exts: Object.keys(OFFICE_ZIP_MIME), maxBytes: 30 * MB, mime: (ext) => OFFICE_ZIP_MIME[ext], matches: (h) => startsWith(h, ZIP) },
  { kind: "office-ole", exts: Object.keys(OFFICE_OLE_MIME), maxBytes: 30 * MB, mime: (ext) => OFFICE_OLE_MIME[ext], matches: (h) => startsWith(h, OLE) },
  {
    kind: "text", exts: ["csv", "txt"], maxBytes: 10 * MB, mime: (ext) => (ext === "csv" ? "text/csv" : "text/plain"),
    matches: (h) => h.length > 0 && !h.includes(0x00),
  },
];

// File Excel quét dòng vàng (FE chỉ cho chọn .xlsx/.xls).
export const TAX_SCAN_KINDS: FileKind[] = DOCUMENT_KINDS
  .filter((k) => k.kind === "office-zip" || k.kind === "office-ole")
  .map((k) => ({ ...k, exts: k.exts.filter((e) => e === "xlsx" || e === "xls"), maxBytes: 20 * MB }));

export const DOCUMENT_MAX_BYTES = Math.max(...DOCUMENT_KINDS.map((k) => k.maxBytes));
export const TAX_SCAN_MAX_BYTES = Math.max(...TAX_SCAN_KINDS.map((k) => k.maxBytes));

export const fileExt = (name: string) => {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
};

export type FileCheck = { ok: true; kind: string; mime: string } | { ok: false; reason: "TYPE" | "SIZE"; maxBytes?: number };

// Đuôi file phải thuộc 1 loại cho phép VÀ nội dung đầu file phải đúng chữ ký của loại đó.
export function checkFile(name: string, head: Buffer, size: number, kinds: FileKind[]): FileCheck {
  const ext = fileExt(name);
  const k = kinds.find((x) => x.exts.includes(ext));
  if (!k || !k.matches(head)) return { ok: false, reason: "TYPE" };
  if (size > k.maxBytes) return { ok: false, reason: "SIZE", maxBytes: k.maxBytes };
  return { ok: true, kind: k.kind, mime: k.mime(ext) };
}

// multer (busboy) giải mã tên file theo latin1 -> tên tiếng Việt/Nhật bị vỡ. Thử đọc lại thành UTF-8.
export function decodeOriginalName(name: string): string {
  const utf8 = Buffer.from(name, "latin1").toString("utf8");
  return utf8.includes("\uFFFD") ? name : utf8;
}

// Tên file an toàn để làm object key / Content-Disposition: bỏ đường dẫn, ký tự điều khiển, ký tự lạ.
export function sanitizeFilename(name: string): string {
  const base = name.normalize("NFC").split(/[\\/]/).pop() ?? "";
  const ext = fileExt(base);
  const stem = (ext ? base.slice(0, -(ext.length + 1)) : base)
    .replace(/[^\p{L}\p{N} ._()-]/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/_+/g, "_")
    .replace(/^[ .]+|[ .]+$/g, "")
    .slice(0, 120);
  const safeExt = ext.replace(/[^a-z0-9]/g, "").slice(0, 10);
  return `${stem || "file"}${safeExt ? `.${safeExt}` : ""}`;
}

// Header tải file: filename ASCII dự phòng + filename* UTF-8 (RFC 6266) - không để ký tự " hay xuống dòng lọt vào header.
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function readHead(filePath: string, bytes = 1024): Promise<Buffer> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export async function removeTempFile(path: string | undefined): Promise<void> {
  if (path) await unlink(path).catch(() => undefined); // file tạm có thể đã bị dọn - không có gì để làm thêm
}

const UPLOAD_TMP = join(tmpdir(), "orderhn-uploads");

// Chứng từ: ghi ra file tạm trên đĩa (không giữ tới 50MB trong RAM), sau đó stream lên MinIO.
const documentMulter = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      try { mkdirSync(UPLOAD_TMP, { recursive: true }); cb(null, UPLOAD_TMP); } catch (e) { cb(e as Error, UPLOAD_TMP); }
    },
  }),
  limits: { fileSize: DOCUMENT_MAX_BYTES, files: 1, fields: 20 },
});

// File thuế chỉ đọc 1 lần rồi bỏ -> memory với giới hạn nhỏ hơn là đủ.
const taxScanMulter = multer({ storage: multer.memoryStorage(), limits: { fileSize: TAX_SCAN_MAX_BYTES, files: 1, fields: 20 } });

// Lỗi multer (quá dung lượng, quá số file...) -> trả 4xx rõ ràng thay vì rơi vào 500.
function wrapMulter(mw: RequestHandler, maxBytes: number): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    mw(req, res, (err?: unknown) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "FILE_TOO_LARGE", message: `File quá lớn (tối đa ${Math.round(maxBytes / MB)}MB)` });
        }
        return res.status(400).json({ error: "BAD_REQUEST", message: err.message });
      }
      next(err);
    });
  };
}

export const documentUpload = wrapMulter(documentMulter.single("file"), DOCUMENT_MAX_BYTES);
export const taxScanUpload = wrapMulter(taxScanMulter.single("file"), TAX_SCAN_MAX_BYTES);
