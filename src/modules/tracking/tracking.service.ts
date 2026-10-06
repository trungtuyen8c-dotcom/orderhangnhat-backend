import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";
import type { BusinessEventName } from "../../app/events/businessEvents.js";
import { AppError } from "../../app/errors/AppError.js";
import { paged, type PageParams } from "../../app/http/pagination.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { createOrphanTrackingSafe } from "../sheets/orphanTracking.js";
import { queueCustomerSheetSync, queueTrackingSheetRow, queueTrackingSheetRowRemoval } from "../sheets/sheet.jobs.js";
import { deleteCartonIfEmpty } from "../cartons/carton.service.js";
import { createInvoiceHistory } from "../invoices/invoice.repository.js";
import * as repo from "./tracking.repository.js";

export type Actor = { id: string; requestId?: string };

const LIST_DEFAULT_LIMIT = 500;

function publish(eventName: BusinessEventName, actor: Actor, trackingId: string, metadata?: Record<string, unknown>) {
  eventBus.publish({ eventName, actorId: actor.id, entityType: "tracking", entityId: trackingId, metadata });
}

// Đẩy sync sheet khách của đơn (gọi SAU commit; tổng đơn đã tính lại trong transaction).
export async function queueOrderCustomerSync(orderId: string): Promise<void> {
  const customerId = await repo.customerIdOfOrder(orderId);
  if (customerId) void queueCustomerSheetSync(customerId);
}

export async function listTrackings(q: repo.TrackingListQuery, page: PageParams | null, sort?: repo.TrackingSort) {
  const where = repo.trackingListWhere(q);
  if (!page) return repo.listTrackings(where, { skip: 0, take: LIST_DEFAULT_LIMIT }, sort);
  const [items, total] = await Promise.all([repo.listTrackings(where, page, sort), repo.countTrackings(where)]);
  return paged(items, total, page);
}

// Tra cứu nhanh: mã tracking này đã gắn đơn nào chưa - để tự điền Mã đơn khi sửa mã quét sai (đỡ gõ tay)
export async function lookupOrderCodeByTracking(code: string): Promise<{ orderCode: string | null }> {
  if (!code) return { orderCode: null };
  const t = await prisma.tracking.findFirst({ where: { code, orderId: { not: null } }, include: { order: { select: { code: true } } } });
  return { orderCode: t?.order?.code ?? null };
}

// Gộp: gán 1 mã tracking VN cho nhiều kiện hàng (rời khỏi tồn kho)
export async function assignVnTracking(ids: string[], vnTrackingCode: string, actor: Actor) {
  await prisma.tracking.updateMany({ where: { id: { in: ids } }, data: { vnTrackingCode: vnTrackingCode.trim(), status: "vn_received" } });
  const trks = await prisma.tracking.findMany({ where: { id: { in: ids } }, select: { orderId: true, order: { select: { customerId: true } } } });
  const customers = new Set(trks.map((t) => t.order?.customerId).filter(Boolean) as string[]);
  for (const c of customers) void queueCustomerSheetSync(c);
  await logAudit({ actorId: actor.id, action: "tracking.assign_vn", metadata: { count: ids.length, vn: vnTrackingCode }, requestId: actor.requestId });
  for (const id of ids) publish("tracking.updated", actor, id, { vnTrackingCode: vnTrackingCode.trim() });
  return { assigned: ids.length };
}

// Backfill: tạo 1 tracking trống cho mọi đơn chưa có tracking (đơn cũ)
export async function backfillEmptyTrackings() {
  const orders = await prisma.order.findMany({ where: { status: { not: "cancelled" }, trackings: { none: {} } }, select: { id: true } });
  if (orders.length) await prisma.tracking.createMany({ data: orders.map((o) => ({ id: uuid(), orderId: o.id, code: "", status: "linked" })) });
  return { created: orders.length };
}

// Dán nhiều: gán mã tracking theo mã đơn (mỗi dòng "JA10017<tab>code"). Mọi ghi trong 1 transaction.
export async function bulkAssign(items: { orderCode: string; code: string }[], actor: Actor) {
  const r = await prisma.$transaction(async (tx) => {
    let updated = 0, created = 0;
    const notFound: string[] = [];
    const orderIds: string[] = [];
    const customers = new Set<string>();
    const touched: string[] = [];
    for (const it of items) {
      const order = await tx.order.findUnique({ where: { code: it.orderCode.trim() }, select: { id: true, customerId: true } });
      if (!order) { notFound.push(it.orderCode); continue; }
      const empty = await tx.tracking.findFirst({ where: { orderId: order.id, code: "" } });
      if (empty) { await tx.tracking.update({ where: { id: empty.id }, data: { code: it.code.trim() } }); touched.push(empty.id); updated++; }
      else { const t = await repo.claimOrCreateTracking(order.id, it.code, {}, tx); touched.push(t.id); created++; }
      customers.add(order.customerId);
      if (!orderIds.includes(order.id)) orderIds.push(order.id);
    }
    for (const oid of orderIds) await recomputeOrderTotals(oid, tx);
    return { updated, created, notFound, orderIds, customers, touched };
  });
  for (const c of r.customers) void queueCustomerSheetSync(c);
  await logAudit({ actorId: actor.id, action: "tracking.bulk_assign", metadata: { updated: r.updated, created: r.created, notFound: r.notFound.length }, requestId: actor.requestId });
  for (const id of r.touched) publish("tracking.assigned", actor, id);
  return { updated: r.updated, created: r.created, notFound: r.notFound };
}

type InvoiceItem = { no: number; name: string; origin: string; unitPriceJpy: number; unit: string; qty: number; amount: number };
type InvoiceTracking = Awaited<ReturnType<typeof repo.findTrackingsForInvoice>>[number];

// Gom dòng hóa đơn từ các tracking (thuần, không đụng DB)
export function composeInvoice(trks: InvoiceTracking[]) {
  const orders = new Map<string, NonNullable<InvoiceTracking["order"]>>();
  for (const t of trks) if (t.order) orders.set(t.order.id, t.order);
  const items: InvoiceItem[] = [];
  let no = 1, total = 0;
  // Tracking đã có customsName (kho tự sửa tên trong sheet để dễ thông quan) -> gộp 1 dòng dùng tên đó thay vì liệt kê từng món gốc
  const usedOrderIds = new Set<string>();
  for (const t of trks) {
    if (!t.order || !t.customsName) continue;
    const amount = t.order.items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);
    const qty = t.order.items.reduce((s, i) => s + i.qty, 0) || 1;
    items.push({ no: no++, name: t.customsName, origin: "", unitPriceJpy: amount / qty, unit: "pcs", qty, amount });
    total += amount;
    usedOrderIds.add(t.order.id);
  }
  for (const o of orders.values()) {
    if (usedOrderIds.has(o.id)) continue;
    for (const it of o.items) {
      const amount = it.qty * Number(it.unitPriceJpy);
      items.push({ no: no++, name: it.name, origin: "", unitPriceJpy: Number(it.unitPriceJpy), unit: "pcs", qty: it.qty, amount });
      total += amount;
    }
  }
  const consignees = [...new Set([...orders.values()].map((o) => o.customer?.name).filter(Boolean))] as string[];
  const addresses = [...new Set([...orders.values()].map((o) => o.customer?.address).filter(Boolean))] as string[];
  return { items, total, consignees, addresses };
}

// Gom dữ liệu hóa đơn (invoice) từ các tracking được chọn + ghi lịch sử xuất (Invoice/InvoiceItem) trong cùng
// 1 transaction - response giữ nguyên như trước, lịch sử dùng cho trang "Hàng chưa lên invoice".
export async function buildInvoice(ids: string[], actor: Actor, note?: string) {
  const r = await prisma.$transaction(async (tx) => {
    const trks = await repo.findTrackingsForInvoice(ids, tx);
    const inv = composeInvoice(trks);
    const invoiceId = trks.length
      ? await createInvoiceHistory(tx, { createdBy: actor.id, note: note?.trim() || null, totalJpy: inv.total, lineCount: inv.items.length, trackings: trks })
      : null;
    return { inv, invoiceId, count: trks.length };
  });
  if (r.invoiceId) await logAudit({ actorId: actor.id, targetId: r.invoiceId, action: "invoice.exported", metadata: { trackings: r.count, total: r.inv.total }, requestId: actor.requestId });
  return r.inv;
}

export type CreateTrackingInput = {
  orderId?: string; code: string; jpName?: string; jpPriceJpy?: number; jpWeightKg?: number; vnWeightKg?: number;
  unitPriceVndPerKg?: number; shipRateCurrency?: "VND" | "JPY"; vnTrackingCode?: string; url?: string; packedAt?: Date; cartonId?: string;
};

// NV mua điền tracking. Ghi 1 bảng (không cần tx); createOrphanTrackingSafe tự bắt trùng P2002 nên không chạy trong tx.
export async function createTracking(data: CreateTrackingInput, actor: Actor) {
  // Mã này có thể đã bị kho quét trước đó (tạo mồ côi chờ gắn đơn) -> claim lại đúng dòng đó thay vì tạo trùng
  // (giữ nguyên cân/kiện/ngày đóng đã có), tránh 1 mã tồn tại 2 Tracking (đếm dùng-chung sai, giá/tên gộp nhầm).
  const existing = await prisma.tracking.findFirst({ where: { code: data.code, orderId: null } });
  const t = existing
    ? await prisma.tracking.update({ where: { id: existing.id }, data: { ...data, cartonManual: data.cartonId !== undefined ? true : existing.cartonManual, status: data.orderId ? "linked" : existing.status } })
    : await createOrphanTrackingSafe({ id: uuid(), ...data, cartonManual: !!data.cartonId, status: data.orderId ? "linked" : "new" });
  if (t.orderId) { await recomputeOrderTotals(t.orderId); await queueOrderCustomerSync(t.orderId); }
  await logAudit({ actorId: actor.id, targetId: t.id, action: "tracking.created", metadata: { code: t.code }, requestId: actor.requestId });
  void queueTrackingSheetRow(t.id);
  if (t.orderId) publish("tracking.assigned", actor, t.id, { orderId: t.orderId });
  return t;
}

export type UpdateTrackingInput = {
  code?: string; jpName?: string; jpPriceJpy?: number; jpWeightKg?: number; vnWeightKg?: number; unitPriceVndPerKg?: number;
  shipRateCurrency?: "VND" | "JPY"; vnTrackingCode?: string; cartonId?: string | null; review?: string | null; url?: string | null;
  packedAt?: Date | null; status?: string; taxCollected?: boolean; customerReceivedAt?: Date | null;
};

export async function updateTracking(id: string, input: UpdateTrackingInput, actor: Actor) {
  const { t, before } = await prisma.$transaction(async (tx) => {
    const before = await tx.tracking.findUnique({ where: { id }, select: { cartonId: true, code: true } });
    // Tự tay đổi/gỡ kiện qua API này -> đánh dấu manual để sync kho không tự đè lại theo BILL/Thùng nữa.
    const data: UpdateTrackingInput & { cartonManual?: boolean } = { ...input };
    if (input.cartonId !== undefined) data.cartonManual = true;
    const t = await tx.tracking.update({ where: { id }, data });
    // Sửa mã tracking qua đường nhanh (Orders...) cũng phải để lại vết - không bắt buộc nhập lý do như "Xử lý lạ",
    // nhưng vẫn cần biết đã từng đổi từ mã gì sang mã gì để tra cứu khi có tranh chấp/nhầm lẫn.
    if (before && input.code !== undefined && input.code !== before.code) {
      await tx.trackingLog.create({
        data: { trackingId: t.id, actorId: actor.id, oldValue: { code: before.code }, newValue: { code: t.code }, reason: "Sửa mã tracking" },
      });
    }
    if (t.orderId) await recomputeOrderTotals(t.orderId, tx);
    return { t, before };
  });
  if (t.orderId) await queueOrderCustomerSync(t.orderId);
  void queueTrackingSheetRow(t.id);
  if (before && before.cartonId !== t.cartonId) await deleteCartonIfEmpty(before.cartonId);
  publish("tracking.updated", actor, t.id, { fields: Object.keys(input) });
  return t;
}

// Xử lý tracking lạ / không khớp: sửa + ghi log (1 transaction)
export async function resolveTracking(id: string, input: { orderId?: string | null; code?: string; reason: string }, actor: Actor) {
  const old = await prisma.tracking.findUnique({ where: { id } });
  if (!old) throw new AppError("NOT_FOUND", 404);
  const updated = await prisma.$transaction(async (tx) => {
    const updated = await tx.tracking.update({
      where: { id: old.id },
      data: {
        orderId: input.orderId === undefined ? old.orderId : input.orderId,
        code: input.code ?? old.code,
        status: "resolved",
      },
    });
    await tx.trackingLog.create({
      data: {
        trackingId: old.id,
        actorId: actor.id,
        oldValue: { orderId: old.orderId, code: old.code, status: old.status },
        newValue: { orderId: updated.orderId, code: updated.code, status: updated.status },
        reason: input.reason,
      },
    });
    // cập nhật tổng cả đơn cũ lẫn đơn mới nếu gán lại
    for (const oid of new Set([old.orderId, updated.orderId].filter(Boolean) as string[])) await recomputeOrderTotals(oid, tx);
    return updated;
  });
  await logAudit({ actorId: actor.id, targetId: old.id, action: "tracking.resolved", metadata: { reason: input.reason }, requestId: actor.requestId });
  for (const oid of new Set([old.orderId, updated.orderId].filter(Boolean) as string[])) await queueOrderCustomerSync(oid);
  void queueTrackingSheetRow(updated.id);
  publish(updated.orderId !== old.orderId ? "tracking.assigned" : "tracking.updated", actor, updated.id, { orderId: updated.orderId, reason: input.reason });
  return updated;
}

export const TRACKING_HAS_COMPANY_COST_MESSAGE = "Tracking đang có khoản chi phí công ty (chakubarai) gắn vào - xóa khoản đó ở Chi phí công ty trước";

export async function assertTrackingDeletable(id: string): Promise<void> {
  if (await repo.countCompanyCostsOfTracking(id)) throw new AppError("TRACKING_HAS_COMPANY_COST", 409, TRACKING_HAS_COMPANY_COST_MESSAGE);
}

export async function deleteTracking(id: string, actor: Actor) {
  const t = await prisma.tracking.findUnique({ where: { id } });
  if (!t) throw new AppError("NOT_FOUND", 404);
  await assertTrackingDeletable(id);
  await prisma.$transaction(async (tx) => {
    await tx.trackingLog.deleteMany({ where: { trackingId: id } });
    await tx.tracking.delete({ where: { id } });
    if (t.orderId) await recomputeOrderTotals(t.orderId, tx);
  });
  if (t.orderId) await queueOrderCustomerSync(t.orderId);
  void queueTrackingSheetRowRemoval(id);
  await deleteCartonIfEmpty(t.cartonId);
  await logAudit({ actorId: actor.id, targetId: id, action: "tracking.deleted", requestId: actor.requestId });
}
