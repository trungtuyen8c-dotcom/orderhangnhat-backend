import { AppError } from "../../app/errors/AppError.js";
import { paged, type PageParams } from "../../app/http/pagination.js";
import { vnMonthRange } from "../../app/vnTime.js";
import * as repo from "./invoice.repository.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// "YYYY-MM" lịch VN -> [start, end); sai định dạng -> 400.
export function monthRangeOr400(month: unknown): { start: Date; end: Date } {
  const m = String(month ?? "");
  if (!MONTH.test(m)) throw new AppError("BAD_REQUEST", 400, "month phải dạng YYYY-MM");
  return vnMonthRange(m);
}

type PendingRow = Awaited<ReturnType<typeof repo.listPending>>[number];

export const orderAmountJpy = (items: { qty: number; unitPriceJpy: unknown }[]) =>
  items.reduce((s, i) => s + i.qty * Number(i.unitPriceJpy), 0);

export function toPendingItem(t: PendingRow) {
  const o = t.order!;
  return {
    trackingId: t.id, trackingCode: t.code, trackingStatus: t.status,
    packedAt: t.packedAt ? t.packedAt.toISOString() : null, jpName: t.jpName,
    orderId: o.id, orderCode: o.code, orderDate: o.orderDate.toISOString(), orderStatus: o.status,
    customerName: o.customer?.name ?? null,
    items: o.items.map((i) => ({ name: i.name, qty: i.qty, unitPriceJpy: Number(i.unitPriceJpy) })),
    amountJpy: orderAmountJpy(o.items),
  };
}

// Tổng toàn bộ kết quả lọc (không chỉ trang đang xem). Tiền tính theo đơn (mỗi đơn 1 lần dù có nhiều tracking).
export function summarize(keys: { orderId: string | null; packedAt: Date | null }[], items: { qty: number; unitPriceJpy: unknown }[]) {
  return {
    trackings: keys.length,
    orders: new Set(keys.map((k) => k.orderId).filter(Boolean)).size,
    unpacked: keys.filter((k) => !k.packedAt).length,
    amountJpy: orderAmountJpy(items),
  };
}

export async function listNotInvoiced(q: repo.PendingQuery, page: PageParams) {
  const where = repo.pendingWhere(q);
  const [rows, keys] = await Promise.all([repo.listPending(where, page), repo.pendingKeys(where)]);
  const orderIds = [...new Set(keys.map((k) => k.orderId).filter(Boolean) as string[])];
  const items = orderIds.length ? await repo.orderItemsOf(orderIds) : [];
  return { ...paged(rows.map(toPendingItem), keys.length, page), totals: summarize(keys, items) };
}

async function namesById(ids: (string | null)[]) {
  const uniq = [...new Set(ids.filter(Boolean) as string[])];
  const users = uniq.length ? await repo.userNames(uniq) : [];
  return new Map(users.map((u) => [u.id, u.fullName || u.email]));
}

export async function listInvoiceHistory(page: PageParams) {
  const [rows, total] = await Promise.all([repo.listInvoices(page), repo.countInvoices()]);
  const names = await namesById(rows.map((r) => r.createdBy));
  return paged(rows.map((r) => ({
    id: r.id, createdAt: r.createdAt.toISOString(), createdBy: r.createdBy, createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
    note: r.note, trackingCount: r.trackingCount, lineCount: r.lineCount, totalJpy: Number(r.totalJpy),
  })), total, page);
}

export async function getInvoice(id: string) {
  const inv = await repo.findInvoice(id);
  if (!inv) throw new AppError("NOT_FOUND", 404);
  const names = await namesById([inv.createdBy]);
  return {
    id: inv.id, createdAt: inv.createdAt.toISOString(), createdBy: inv.createdBy,
    createdByName: inv.createdBy ? names.get(inv.createdBy) ?? null : null,
    note: inv.note, trackingCount: inv.trackingCount, lineCount: inv.lineCount, totalJpy: Number(inv.totalJpy),
    items: inv.items.map((i) => ({
      id: i.id, trackingId: i.trackingId, trackingCode: i.trackingCode, currentTrackingCode: i.tracking?.code ?? null,
      orderId: i.orderId, orderCode: i.orderCode, customerName: i.customerName,
    })),
  };
}
