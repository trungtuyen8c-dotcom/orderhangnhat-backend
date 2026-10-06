import { v4 as uuid } from "uuid";
import type { Readable } from "stream";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { parseSheetId } from "../../integrations/google/googleSheets.client.js";
import { getObjectStream, putObjectFromFile, removeObjectQuietly } from "../../integrations/minio/documentStorage.js";
import { readInvoiceTaxRows, readInvoiceTaxRowsFromExcel } from "../sheets/invoiceTaxSheet.service.js";
import { vnMonthRange } from "../../app/vnTime.js";
import {
  billOf, findByName, nameRowKey, pickPurchaseUrl, suggestByName,
  type SheetTaxRow, type TaxRowOut, type TaxSuggestion,
} from "./taxMatching.js";

export type Actor = { id: string; requestId?: string };

const TAX_SHEET_KEY = "invoice_tax_sheet_id";
const badRequest = () => new AppError("BAD_REQUEST", 400);

// "YYYY-MM" -> [start, end) giờ VN; sai định dạng -> null (route tự quyết định body lỗi).
export function parseMonth(month: unknown): { start: Date; end: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ""));
  return m ? vnMonthRange(`${m[1]}-${m[2]}`) : null;
}

// ===== Cấu hình sheet nháp kho ("invoice test") =====

export async function getTaxConfig() {
  const cfg = await prisma.appConfig.findUnique({ where: { key: TAX_SHEET_KEY } });
  return { sheetUrl: cfg?.value ?? "", sheetId: cfg?.value ? parseSheetId(cfg.value) : null };
}

export async function setTaxConfig(sheetUrl: string | null | undefined, actor: Actor) {
  const url = (sheetUrl ?? "").trim();
  if (url && !parseSheetId(url)) throw new AppError("BAD_URL", 400, "Link Google Sheet không hợp lệ");
  await prisma.appConfig.upsert({ where: { key: TAX_SHEET_KEY }, update: { value: url }, create: { key: TAX_SHEET_KEY, value: url } });
  await logAudit({ actorId: actor.id, action: "shipments.tax_config_set", requestId: actor.requestId });
  return { sheetUrl: url, sheetId: url ? parseSheetId(url) : null };
}

// ===== Khớp dòng vàng "cần lấy thuế" =====

// Khớp danh sách dòng vàng (đọc từ Google Sheet hoặc từ file Excel upload) với bảng Tracking.
// persist=true (luồng nội bộ): bật needsTax cho tracking khớp + đăng ký sẵn khóa ghi chú cho dòng khớp theo tên.
// persist=false (kênh /api/ext cho MCP): chỉ đọc, không có side-effect ẩn khi AI gọi 1 GET.
export async function matchTaxRows(sheetRows: SheetTaxRow[], opts: { persist: boolean }): Promise<TaxRowOut[]> {
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
          select: { name: true, order: { select: { code: true, nick: true, customer: { select: { name: true } }, items: { select: { name: true, url: true } } } } },
          take: 5000,
        })
      : Promise.resolve([]),
  ]);
  // Đánh dấu needsTax=true cho tracking khớp được (không tự tắt lại nếu dòng hết vàng sau này - giữ lịch sử đã từng cần lấy thuế).
  const toFlag = trks.filter((t) => !t.needsTax).map((t) => t.id);
  if (opts.persist && toFlag.length) await prisma.tracking.updateMany({ where: { id: { in: toFlag } }, data: { needsTax: true } });
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

  // Đơn nào đã có dòng khớp rồi (qua mã tracking, hoặc vừa khớp tên ở dòng trước trong cùng lượt quét) thì
  // loại khỏi danh sách ứng viên - tránh gợi ý/khớp trùng 1 đơn cho nhiều dòng tô vàng khác nhau.
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

  // Dòng khớp theo tên không có mã tracking -> lưu Ghi chú/"Đã lấy thuế" theo khóa tổng hợp
  // bill+đơn+tên hàng (đúng công thức taxRowKey ở FE) thay vì mã tracking.
  const nameNoteKeys = nameOut.map((r) => nameRowKey(r.bill, r.orderCode, r.itemName));
  const nameNotes = nameNoteKeys.length ? await prisma.taxRowNote.findMany({ where: { trackingCode: { in: nameNoteKeys } } }) : [];
  const nameNoteByKey = new Map(nameNotes.map((n) => [n.trackingCode, n]));
  for (const r of nameOut) {
    const found = nameNoteByKey.get(nameRowKey(r.bill, r.orderCode, r.itemName));
    if (found) { r.note = found.note || null; r.taxCollected = found.taxCollected; }
  }
  // Đăng ký sẵn (taxCollected=false) cho dòng khớp theo tên vừa thấy lần đầu - để tồn tại lâu dài, không
  // phụ thuộc quét lại đúng file đó. Cho phép xử lý rải rác nhiều ngày (vd lọc theo Nick, gom 1 tuần 1 lần)
  // mà vẫn được /control/overview đếm nhắc, không rơi mất khi quét file khác.
  if (opts.persist) {
    const missingKeys = [...new Set(
      nameOut.filter((r) => !r.unmatched && !nameNoteByKey.has(nameRowKey(r.bill, r.orderCode, r.itemName)))
        .map((r) => nameRowKey(r.bill, r.orderCode, r.itemName)),
    )];
    if (missingKeys.length) {
      await prisma.taxRowNote.createMany({ data: missingKeys.map((k) => ({ trackingCode: k, note: "", taxCollected: false })), skipDuplicates: true });
    }
  }

  return [...codeOut, ...nameOut];
}

// Mã tracking needsTax=true (tự set ngay lúc đóng hàng, không cần tô vàng) nhưng CHƯA từng quét thấy trên
// sheet/file (chưa có tên hàng/giá cụ thể) - lấy tạm tên/giá từ chính đơn hàng trong hệ thống để vẫn hiện
// ra bảng, không phải chờ ai đó tô vàng thủ công mới thấy.
async function buildExtraNeedsTaxRows(shownTrackingIds: Set<string>): Promise<TaxRowOut[]> {
  // Tracking mồ côi (chưa gắn đơn) KHÔNG hiện ở đây - chưa biết khách thì "cần lấy thuế" chưa có ý nghĩa.
  // Kho tự tìm khách/mở hàng ngoài quy trình riêng, gán đơn ở Orders (tự claim lại đúng dòng này) là tự
  // hiện đúng ở đây ngay, không cần làm gì thêm - cờ needsTax vẫn giữ ngầm từ lúc đóng hàng.
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
      bill: t.carton ? billOf(t.carton.code) : null, matchedBy: t.order ? "tracking" : null, suggestion: null,
    };
  });
}

// Các dòng đang tô vàng trên sheet nháp kho ("cần lấy thuế") + tracking needsTax chưa từng quét thấy.
export async function listTaxRows(opts: { persist: boolean }): Promise<TaxRowOut[]> {
  const { sheetId } = await getTaxConfig();
  const sheetRows = sheetId ? await readInvoiceTaxRows(sheetId) : [];
  const rows = await matchTaxRows(sheetRows, opts);
  const shownIds = new Set(rows.filter((r) => r.trackingId).map((r) => r.trackingId!));
  return [...rows, ...(await buildExtraNeedsTaxRows(shownIds))];
}

// Quét file Excel chứng từ GA upload trực tiếp -> đọc dòng vàng + khớp Tracking, KHÔNG lưu file.
export async function scanTaxFile(buffer: Buffer): Promise<TaxRowOut[]> {
  let sheetRows: SheetTaxRow[];
  try { sheetRows = await readInvoiceTaxRowsFromExcel(buffer); }
  catch { throw new AppError("BAD_FILE", 400, "Không đọc được file Excel"); }
  return matchTaxRows(sheetRows, { persist: true });
}

// Ghi chú thủ công + "Đã lấy thuế" theo khóa (mã tracking thật, hoặc khóa tổng hợp cho dòng khớp theo tên
// không có mã tracking) - không tự gán đơn. Chỉ gửi field nào cần đổi, field còn lại giữ nguyên giá trị cũ.
export async function setTaxRowNote(code: string, input: { note?: string | null; taxCollected?: boolean }, actor: Actor) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.taxRowNote.findUnique({ where: { trackingCode: code } });
    const note = input.note !== undefined ? (input.note ?? "").trim() : (existing?.note ?? "");
    const taxCollected = input.taxCollected !== undefined ? input.taxCollected : (existing?.taxCollected ?? false);
    if (!note && !taxCollected) {
      if (existing) await tx.taxRowNote.delete({ where: { trackingCode: code } });
      return { trackingCode: code, note: null, taxCollected: false };
    }
    const row = await tx.taxRowNote.upsert({
      where: { trackingCode: code },
      update: { note, taxCollected, updatedBy: actor.id },
      create: { trackingCode: code, note, taxCollected, updatedBy: actor.id },
    });
    return { trackingCode: row.trackingCode, note: row.note || null, taxCollected: row.taxCollected };
  });
}

// ===== Soát thuế theo tháng =====

// Mọi Tracking đã đóng hàng (packedAt) trong tháng đều phải từng xuất hiện 1 lần làm dòng vàng "cần lấy thuế"
// (needsTax) - đơn nào chưa từng khớp (needsTax=false) là bị sót, cần lên bù.
export async function taxAudit(range: { start: Date; end: Date }) {
  const trks = await prisma.tracking.findMany({
    where: { packedAt: { gte: range.start, lt: range.end }, order: { status: { not: "cancelled" } } },
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

export async function setTaxAuditDismissed(trackingId: string, dismissed: boolean) {
  await prisma.tracking.update({ where: { id: trackingId }, data: { taxAuditDismissed: dismissed } });
  return { ok: true };
}

// ===== Checklist hóa đơn theo Bill =====

// Danh sách Bill theo ngày trong tháng (từ Carton, code dạng "BILL Thùng" - vd "GE 1") kèm trạng thái
// "đã lấy hóa đơn" - hóa đơn/biên lai vẫn lưu ở Google Drive (Tháng>Ngày>Bill), đây chỉ theo dõi đã-lấy-chưa.
export async function invoiceChecklist(range: { start: Date; end: Date }) {
  const cartons = await prisma.carton.findMany({
    where: { packedDate: { gte: range.start, lt: range.end } },
    select: { code: true, packedDate: true, trackings: { select: { id: true } } },
  });
  const groups = new Map<string, { date: string; bill: string; cartonCount: number; trackingCount: number }>();
  for (const c of cartons) {
    if (!c.packedDate) continue;
    const bill = billOf(c.code);
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

export async function setInvoiceDone(key: string, done: boolean, actor: Actor) {
  await prisma.billInvoiceStatus.upsert({
    where: { key },
    update: { done, updatedBy: actor.id },
    create: { key, done, updatedBy: actor.id },
  });
  return { ok: true };
}

// ===== Chứng từ (MinIO) =====

export type UploadedDocument = { path: string; size: number; safeName: string; mime: string };

const DOC_TYPE_RE = /^[a-z0-9_-]{1,40}$/i;

export async function uploadDocument(
  file: UploadedDocument,
  input: { type?: string; orderId?: string; invoiceDate?: string },
  actor: Actor,
) {
  if (!input.type || !DOC_TYPE_RE.test(input.type)) throw badRequest();
  const invoiceDate = input.invoiceDate ? new Date(input.invoiceDate) : null;
  if (invoiceDate && Number.isNaN(invoiceDate.getTime())) throw badRequest();

  const key = `documents/${input.type}/${uuid()}-${file.safeName}`;
  await putObjectFromFile(key, file.path, file.size, file.mime);
  let doc;
  try {
    doc = await prisma.document.create({
      data: { id: uuid(), type: input.type, objectKey: key, orderId: input.orderId || null, invoiceDate, uploadedBy: actor.id },
    });
  } catch (e) {
    await removeObjectQuietly(key);
    throw e;
  }
  await logAudit({ actorId: actor.id, targetId: doc.id, action: "document.uploaded", metadata: { type: input.type }, requestId: actor.requestId });
  return doc;
}

export function listDocuments(orderId?: string) {
  return prisma.document.findMany({ where: orderId ? { orderId } : {}, orderBy: { createdAt: "desc" }, take: 200 });
}

// Bản cho kênh ext (MCP): không lộ objectKey/uploadedBy.
export function listDocumentsPublic(orderId?: string) {
  return prisma.document.findMany({
    where: orderId ? { orderId } : undefined,
    orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, type: true, orderId: true, invoiceDate: true, createdAt: true },
  });
}

export async function openDocument(id: string): Promise<{ filename: string; stream: Readable }> {
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) throw new AppError("NOT_FOUND", 404);
  try {
    const stream = await getObjectStream(doc.objectKey);
    return { filename: doc.objectKey.split("/").pop() ?? "file", stream };
  } catch {
    throw new AppError("DOWNLOAD_FAILED", 500);
  }
}
