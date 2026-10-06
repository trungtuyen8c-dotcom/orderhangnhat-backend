import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { putObjectFromFile, removeObjectQuietly } from "../../integrations/minio/documentStorage.js";
import type { Actor, UploadedDocument } from "./shipments.service.js";

// Hóa đơn mua đính trực tiếp vào 1 tracking (M7-1). Lưu chung bảng Document (type purchase_invoice) + trackingId.
export const TRACKING_DOC_TYPE = "purchase_invoice";
export const MAX_COUNT_IDS = 1000;

const publicSelect = { id: true, type: true, trackingId: true, orderId: true, objectKey: true, uploadedBy: true, createdAt: true } as const;

type DocRow = { id: string; type: string; trackingId: string | null; orderId: string | null; objectKey: string; uploadedBy: string | null; createdAt: Date };

// objectKey = documents/<type>/<uuid>-<tên an toàn> -> trả tên gốc để FE hiện, không lộ key MinIO.
export function toTrackingDocOut(d: DocRow) {
  const last = d.objectKey.split("/").pop() ?? "";
  const fileName = last.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, "") || last;
  return { id: d.id, type: d.type, trackingId: d.trackingId, orderId: d.orderId, fileName, uploadedBy: d.uploadedBy, createdAt: d.createdAt };
}

async function requireTracking(trackingId: string) {
  const t = await prisma.tracking.findUnique({ where: { id: trackingId }, select: { id: true, code: true } });
  if (!t) throw new AppError("NOT_FOUND", 404, "Không tìm thấy tracking");
  return t;
}

export async function uploadTrackingDocument(trackingId: string, file: UploadedDocument, actor: Actor) {
  const trk = await requireTracking(trackingId);
  const key = `documents/${TRACKING_DOC_TYPE}/${uuid()}-${file.safeName}`;
  await putObjectFromFile(key, file.path, file.size, file.mime);
  let doc: DocRow;
  try {
    doc = await prisma.document.create({
      data: { id: uuid(), type: TRACKING_DOC_TYPE, objectKey: key, trackingId: trk.id, uploadedBy: actor.id },
      select: publicSelect,
    });
  } catch (e) {
    await removeObjectQuietly(key);
    throw e;
  }
  await logAudit({
    actorId: actor.id, targetId: doc.id, action: "document.uploaded",
    metadata: { type: TRACKING_DOC_TYPE, trackingId: trk.id, trackingCode: trk.code }, requestId: actor.requestId,
  });
  return toTrackingDocOut(doc);
}

export async function listTrackingDocuments(trackingId: string) {
  await requireTracking(trackingId);
  const docs = await prisma.document.findMany({ where: { trackingId }, orderBy: { createdAt: "desc" }, select: publicSelect });
  return docs.map(toTrackingDocOut);
}

// Đếm file theo nhiều tracking 1 lần (bảng Kho/Chứng từ hiện icon kẹp giấy + số) -> { [trackingId]: n }, chỉ id có file.
export async function countTrackingDocuments(trackingIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(trackingIds)];
  if (!ids.length) return {};
  const groups = await prisma.document.groupBy({ by: ["trackingId"], where: { trackingId: { in: ids } }, _count: { _all: true } });
  const out: Record<string, number> = {};
  for (const g of groups) if (g.trackingId) out[g.trackingId] = g._count._all;
  return out;
}

// Xóa bản ghi trước, rồi mới xóa object MinIO (lỗi xóa object chỉ log - không để bản ghi trỏ tới file đã mất).
export async function deleteTrackingDocument(trackingId: string, docId: string, actor: Actor) {
  const doc = await prisma.document.findFirst({ where: { id: docId, trackingId }, select: publicSelect });
  if (!doc) throw new AppError("NOT_FOUND", 404, "Không tìm thấy file");
  const { count } = await prisma.document.deleteMany({ where: { id: docId, trackingId } });
  if (!count) throw new AppError("NOT_FOUND", 404, "Không tìm thấy file");
  await removeObjectQuietly(doc.objectKey);
  await logAudit({ actorId: actor.id, targetId: doc.id, action: "document.deleted", metadata: { type: doc.type, trackingId }, requestId: actor.requestId });
  return { ok: true };
}
