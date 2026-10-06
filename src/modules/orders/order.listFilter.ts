import { Prisma, type OrderStatus } from "@prisma/client";
import { LegacyError } from "../../app/http/legacyError.js";
import { vnDayEnd, vnDayStart, vnMonthRange } from "../../app/vnTime.js";
import { ORDER_STATUSES } from "./order.state.js";
import { isPayLater } from "./order.validation.js";

// Bộ lọc GET /orders - dùng chung cho Prisma where (danh sách/đếm) và SQL thô (gom theo tháng),
// 2 builder bên dưới PHẢI cho cùng 1 tập đơn.
export const EMPTY = "__empty__";
export type OrderListFilter = {
  source: string;
  exclude: string[];
  q?: string;
  status: OrderStatus[];
  excludeStatus: OrderStatus[];
  nick?: string;          // EMPTY = chưa có nick
  paymentMethod?: string; // EMPTY = không món nào có PTTT
  tracking?: "has" | "none";
  paid?: "yes" | "no";    // yahooPaidAt
  customerId?: string;
  from?: string;          // YYYY-MM-DD lịch VN, theo orderDate
  to?: string;
  month?: string;         // YYYY-MM lịch VN | "latest" (tháng mới nhất có đơn trong bộ lọc)
};
export type OrderSortField = "orderDate" | "code" | "totalVnd" | "createdAt";
export type OrderSort = { field: OrderSortField; dir: "asc" | "desc" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SORT_FIELDS: OrderSortField[] = ["orderDate", "code", "totalVnd", "createdAt"];

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v)).trim();
const list = (v: unknown) => str(v).split(",").map((s) => s.trim()).filter(Boolean);
const bad = (field: string) => new LegacyError(400, "BAD_REQUEST", `Tham số không hợp lệ: ${field}`);

function statuses(v: unknown, field: string): OrderStatus[] {
  const xs = list(v);
  for (const s of xs) if (!(ORDER_STATUSES as readonly string[]).includes(s)) throw bad(field);
  return xs as OrderStatus[];
}

export function parseOrderListQuery(query: Record<string, unknown>): { filter: OrderListFilter; sort: OrderSort } {
  const pick = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined => {
    const s = str(v);
    if (!s) return undefined;
    if (!(allowed as readonly string[]).includes(s)) throw bad(field);
    return s as T;
  };
  const date = (v: unknown, field: string) => {
    const s = str(v);
    if (s && !DAY.test(s)) throw bad(field);
    return s || undefined;
  };
  const month = str(query.month);
  if (month && month !== "latest" && !MONTH.test(month)) throw bad("month");
  const customerId = str(query.customerId);
  if (customerId && !UUID.test(customerId)) throw bad("customerId");
  const filter: OrderListFilter = {
    source: str(query.source),
    exclude: list(query.exclude),
    q: str(query.q) || undefined,
    status: statuses(query.status, "status"),
    excludeStatus: statuses(query.excludeStatus, "excludeStatus"),
    nick: str(query.nick) || undefined,
    paymentMethod: str(query.paymentMethod) || undefined,
    tracking: pick(query.tracking, ["has", "none"] as const, "tracking"),
    paid: pick(query.paid, ["yes", "no"] as const, "paid"),
    customerId: customerId || undefined,
    from: date(query.from, "from"),
    to: date(query.to, "to"),
    month: month || undefined,
  };
  const sort: OrderSort = {
    field: pick(query.sort, SORT_FIELDS, "sort") ?? "orderDate",
    dir: pick(query.order, ["asc", "desc"] as const, "order") ?? "desc",
  };
  return { filter, sort };
}

// Phạm vi trang (nguồn đơn) - giữ đúng hành vi cũ: source chỉ có tác dụng với Yahoo/Mercari.
export function scopeWhere(source: string, exclude: string[]): Prisma.OrderWhereInput | undefined {
  if (isPayLater(source)) return { source };
  return exclude.length ? { source: { notIn: exclude } } : undefined;
}

const hasPm: Prisma.OrderItemWhereInput = { AND: [{ paymentMethod: { not: null } }, { paymentMethod: { not: "" } }] };
const hasCode: Prisma.TrackingWhereInput = { code: { not: "" } };

// month đã resolve (không phải "latest") hoặc bỏ qua -> where cho danh sách/đếm.
export function toOrderWhere(f: OrderListFilter, month?: string): Prisma.OrderWhereInput | undefined {
  const scope = scopeWhere(f.source, f.exclude);
  const and: Prisma.OrderWhereInput[] = [];
  if (f.q) {
    const c = { contains: f.q, mode: "insensitive" as const };
    and.push({ OR: [{ code: c }, { customer: { name: c } }, { items: { some: { url: c } } }, { trackings: { some: { code: c } } }] });
  }
  if (f.status.length) and.push({ status: { in: f.status } });
  if (f.excludeStatus.length) and.push({ status: { notIn: f.excludeStatus } });
  if (f.nick === EMPTY) and.push({ OR: [{ nick: null }, { nick: "" }] });
  else if (f.nick) and.push({ nick: f.nick });
  if (f.paymentMethod === EMPTY) and.push({ items: { none: hasPm } });
  else if (f.paymentMethod) and.push({ items: { some: { paymentMethod: f.paymentMethod } } });
  if (f.tracking === "has") and.push({ trackings: { some: hasCode } });
  if (f.tracking === "none") and.push({ trackings: { none: hasCode } });
  if (f.paid === "yes") and.push({ yahooPaidAt: { not: null } });
  if (f.paid === "no") and.push({ yahooPaidAt: null });
  if (f.customerId) and.push({ customerId: f.customerId });
  if (f.from) and.push({ orderDate: { gte: vnDayStart(f.from) } });
  if (f.to) and.push({ orderDate: { lte: vnDayEnd(f.to) } });
  if (month) { const r = vnMonthRange(month); and.push({ orderDate: { gte: r.start, lt: r.end } }); }
  if (!and.length) return scope;
  return { AND: scope ? [scope, ...and] : and };
}

// Cùng bộ lọc (không gồm month) dưới dạng SQL trên bảng orders alias "o".
export function toOrderSql(f: OrderListFilter): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (isPayLater(f.source)) parts.push(Prisma.sql`o.source = ${f.source}`);
  else if (f.exclude.length) parts.push(Prisma.sql`o.source NOT IN (${Prisma.join(f.exclude)})`);
  if (f.q) {
    const p = `%${f.q}%`;
    parts.push(Prisma.sql`(o.code ILIKE ${p}
      OR EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id AND c.name ILIKE ${p})
      OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.url ILIKE ${p})
      OR EXISTS (SELECT 1 FROM trackings t WHERE t.order_id = o.id AND t.code ILIKE ${p}))`);
  }
  if (f.status.length) parts.push(Prisma.sql`o.status::text IN (${Prisma.join(f.status)})`);
  if (f.excludeStatus.length) parts.push(Prisma.sql`o.status::text NOT IN (${Prisma.join(f.excludeStatus)})`);
  if (f.nick === EMPTY) parts.push(Prisma.sql`(o.nick IS NULL OR o.nick = '')`);
  else if (f.nick) parts.push(Prisma.sql`o.nick = ${f.nick}`);
  if (f.paymentMethod === EMPTY)
    parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.payment_method IS NOT NULL AND i.payment_method <> '')`);
  else if (f.paymentMethod)
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.payment_method = ${f.paymentMethod})`);
  if (f.tracking === "has") parts.push(Prisma.sql`EXISTS (SELECT 1 FROM trackings t WHERE t.order_id = o.id AND t.code <> '')`);
  if (f.tracking === "none") parts.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM trackings t WHERE t.order_id = o.id AND t.code <> '')`);
  if (f.paid === "yes") parts.push(Prisma.sql`o.yahoo_paid_at IS NOT NULL`);
  if (f.paid === "no") parts.push(Prisma.sql`o.yahoo_paid_at IS NULL`);
  if (f.customerId) parts.push(Prisma.sql`o.customer_id = ${f.customerId}::uuid`);
  if (f.from) parts.push(Prisma.sql`o.order_date >= ${vnDayStart(f.from)}`);
  if (f.to) parts.push(Prisma.sql`o.order_date <= ${vnDayEnd(f.to)}`);
  return parts.length ? Prisma.join(parts, " AND ") : Prisma.sql`TRUE`;
}

export function toOrderBy(s: OrderSort): Prisma.OrderOrderByWithRelationInput[] {
  switch (s.field) {
    case "code": return [{ code: s.dir }];
    case "totalVnd": return [{ totalVnd: { sort: s.dir, nulls: "last" } }, { orderDate: "desc" }];
    case "createdAt": return [{ createdAt: s.dir }];
    default: return [{ orderDate: s.dir }, { createdAt: s.dir }];
  }
}
