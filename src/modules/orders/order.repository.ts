import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import type { PageParams } from "../../app/http/pagination.js";

type Tx = Prisma.TransactionClient;

// GET /orders - trackings luôn cùng select; pay-later (Yahoo/Mercari) cần thêm giá món để hiện tổng ở bảng.
// Không phân trang -> tối đa LIST_LEGACY_LIMIT đơn mới nhất (như /customers, /trackings).
export const LIST_LEGACY_LIMIT = 500;
const DEFAULT_ORDER_BY: Prisma.OrderOrderByWithRelationInput[] = [{ orderDate: "desc" }, { createdAt: "desc" }];

export async function listOrders(
  where: Prisma.OrderWhereInput | undefined, payLater: boolean, page: PageParams | null,
  orderBy: Prisma.OrderOrderByWithRelationInput[] = DEFAULT_ORDER_BY,
) {
  const args = {
    where,
    orderBy,
    include: {
      customer: { select: { name: true } },
      trackings: {
        select: { id: true, code: true, review: true, url: true, vnTrackingCode: true, deliveredAt: true, needsTax: true, taxCollected: true },
        orderBy: { createdAt: "asc" as const },
      },
      items: payLater
        ? { select: { unitPriceJpy: true, qty: true, shipJpy: true, url: true, paymentMethod: true } }
        : { select: { url: true, paymentMethod: true } },
    },
  };
  if (!page) return { rows: await prisma.order.findMany({ ...args, take: LIST_LEGACY_LIMIT }) };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({ ...args, skip: page.skip, take: page.take }),
    prisma.order.count({ where }),
  ]);
  return { rows, total };
}

export type MonthBucket = { month: string; count: number; totalVnd: number };

// Gom theo tháng lịch VN (order_date lưu UTC) trên toàn bộ tập đã lọc - 1 query GROUP BY.
export async function monthBuckets(filterSql: Prisma.Sql): Promise<MonthBucket[]> {
  const rows = await prisma.$queryRaw<{ month: string; count: number; total: string }[]>`
    SELECT to_char(o.order_date + interval '7 hours', 'YYYY-MM') AS month,
           COUNT(*)::int AS count, COALESCE(SUM(o.total_vnd), 0)::text AS total
    FROM orders o WHERE ${filterSql}
    GROUP BY 1 ORDER BY 1 DESC`;
  return rows.map((r) => ({ month: r.month, count: Number(r.count), totalVnd: Number(r.total) }));
}

// "Đang nợ" Yahoo/Mercari: tổng ¥ (giá x SL + ship món) các đơn chưa bấm Đã thanh toán, không theo bộ lọc.
export async function pendingJpy(source: string): Promise<number> {
  const [r] = await prisma.$queryRaw<{ total: string }[]>`
    SELECT COALESCE(SUM(i.unit_price_jpy * i.qty + COALESCE(i.ship_jpy, 0)), 0)::text AS total
    FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.source = ${source} AND o.yahoo_paid_at IS NULL`;
  return Number(r?.total ?? 0);
}

// Giá trị cho ô lọc Nick / PTTT trong phạm vi trang (GROUP BY, không tải đơn).
export async function listFacets(scope: Prisma.OrderWhereInput | undefined) {
  const [nicks, methods] = await Promise.all([
    prisma.order.groupBy({ by: ["nick"], where: { AND: [scope ?? {}, { nick: { not: null } }, { nick: { not: "" } }] }, orderBy: { nick: "asc" } }),
    prisma.orderItem.groupBy({
      by: ["paymentMethod"],
      where: { AND: [{ paymentMethod: { not: null } }, { paymentMethod: { not: "" } }, ...(scope ? [{ order: scope }] : [])] },
      orderBy: { paymentMethod: "asc" },
    }),
  ]);
  return { nicks: nicks.map((n) => n.nick!), paymentMethods: methods.map((m) => m.paymentMethod!) };
}

export function listFixRequests() {
  return prisma.order.findMany({
    where: { fixRequest: { not: null } },
    orderBy: { fixRequestedAt: "desc" },
    take: 50,
    select: { id: true, code: true, fixRequest: true, customer: { select: { name: true } } },
  });
}

export function findByCodeInsensitive(code: string) {
  return prisma.order.findFirst({
    where: { code: { equals: code, mode: "insensitive" } },
    select: { id: true, code: true, customer: { select: { name: true } } },
  });
}

export async function findDuplicateOrderCodes(url: string, code: string, excludeOrderId: string) {
  const urlOrders = url
    ? await prisma.orderItem.findMany({
        where: { url, ...(excludeOrderId ? { orderId: { not: excludeOrderId } } : {}) },
        select: { order: { select: { code: true } } },
      })
    : [];
  const codeOrders = code
    ? await prisma.tracking.findMany({
        where: { code, orderId: { not: null }, ...(excludeOrderId ? { NOT: { orderId: excludeOrderId } } : {}) },
        select: { order: { select: { code: true } } },
      })
    : [];
  return {
    urlOrders: [...new Set(urlOrders.map((i) => i.order.code))],
    codeOrders: [...new Set(codeOrders.map((t) => t.order!.code))],
  };
}

export async function findDetail(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      customer: true,
      items: true,
      trackings: { orderBy: { createdAt: "desc" } },
      payments: { orderBy: { createdAt: "asc" } },
      logs: { orderBy: { createdAt: "desc" }, take: 200 },
    },
  });
  if (!order) return null;
  const [debt, documents, trackingLogs] = await Promise.all([
    prisma.debt.findFirst({ where: { orderId: order.id } }),
    prisma.document.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "desc" } }),
    // Lịch sử sửa mã tracking (kể cả sửa nhanh ở Orders, không chỉ "Xử lý lạ") - để biết đã từng đổi từ mã nào.
    prisma.trackingLog.findMany({ where: { trackingId: { in: order.trackings.map((t) => t.id) } }, orderBy: { createdAt: "desc" } }),
  ]);
  return { order, debt, documents, trackingLogs };
}

// Mã đơn JA10001, JA10002... tăng dần
export async function nextOrderCode(db: Tx = prisma): Promise<string> {
  const last = await db.order.findFirst({ where: { code: { startsWith: "JA" } }, orderBy: { code: "desc" }, select: { code: true } });
  const n = last?.code ? parseInt(last.code.slice(2), 10) || 10000 : 10000;
  return `JA${n + 1}`;
}

// Khoản phải trả kho/cty (vd 着払い) gắn vào các tracking này - FK Restrict, phải gỡ khoản trước khi xóa tracking.
export function findCompanyCostsOnTrackings(trackingIds: string[]) {
  if (!trackingIds.length) return Promise.resolve([]);
  return prisma.companyCost.findMany({ where: { refId: { in: trackingIds } }, select: { refId: true, kind: true } });
}

// Gỡ toàn bộ dữ liệu phụ thuộc rồi xóa đơn - dùng chung cho xóa thường và xóa cưỡng chế (trong cùng 1 transaction).
export async function detachAndDeleteOrder(tx: Tx, orderId: string) {
  // Còn giao dịch ví nhập tay có gắn mã đơn (không phải auto trừ thẻ, đã gỡ trước đó): giữ giao dịch + số dư, chỉ bỏ liên kết.
  await tx.walletTxn.updateMany({ where: { refOrderId: orderId }, data: { refOrderId: null } });
  await tx.debt.deleteMany({ where: { orderId } });
  // Chi phí/đền bù là sổ lỗ nội bộ -> giữ lại, chỉ bỏ liên kết đơn.
  await tx.expense.updateMany({ where: { orderId }, data: { orderId: null } });
  await tx.weightRecon.deleteMany({ where: { orderId } });
  // Tracking chưa gõ mã (code rỗng, chỉ là placeholder chờ điền) -> xóa luôn, không để mồ côi vô nghĩa.
  // Placeholder đã có khoản phải trả kho (FK Restrict) thì không xóa, để updateMany bên dưới gỡ về mồ côi.
  await tx.tracking.deleteMany({ where: { orderId, code: "", companyCosts: { none: {} } } });
  await tx.tracking.updateMany({ where: { orderId }, data: { orderId: null, status: "new" } });
  await tx.order.delete({ where: { id: orderId } });
}
