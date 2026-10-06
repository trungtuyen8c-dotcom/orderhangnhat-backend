import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import { vnMonthKey, vnMonthRange } from "../../app/vnTime.js";

const EMPTY_ALERTS = { count: 0, orders: [] };

// "Hoàn tất" thực tế không dựa vào Order.status (trường này ít khi được cập nhật tay) mà suy ra từ dữ liệu thật:
// - Khách không cân ở Kho VN (externalWarehouse/skipVnWeighing): xong khi đã đủ giá, có tracking Nhật, đã đóng
//   hàng (packedAt) và đã lấy thuế xong (mọi tracking needsTax=true đều taxCollected=true).
// - Khách có cân: thêm điều kiện đủ cân Nhật/VN từng mã. KHÔNG bắt buộc có Tracking VN - nhiều đơn giao tay/lấy
//   trực tiếp không đi qua ship nội địa nên không bao giờ có mã này dù đơn đã xong thật sự.
export function isOrderComplete(o: {
  externalWarehouse: boolean; skipVnWeighing: boolean;
  items: { unitPriceJpy: unknown }[];
  trackings: { packedAt: Date | null; needsTax: boolean; taxCollected: boolean; jpWeightKg: unknown; vnWeightKg: unknown }[];
}): boolean {
  if (!o.trackings.length) return false;
  if (o.items.some((i) => Number(i.unitPriceJpy) === 0)) return false;
  if (o.trackings.some((t) => !t.packedAt)) return false;
  if (o.trackings.some((t) => t.needsTax && !t.taxCollected)) return false;
  if (!o.externalWarehouse && !o.skipVnWeighing) {
    if (o.trackings.some((t) => t.jpWeightKg == null || t.vnWeightKg == null)) return false;
  }
  return true;
}

// Kết quả job quét đơn trễ (jobs/alerts.ts) cache trong Redis.
export async function getAlerts() {
  const raw = await redis.get("alerts:late_orders");
  return raw ? JSON.parse(raw) : EMPTY_ALERTS;
}

export async function getOverview() {
  const [byStatus, customers, totalOrders, cancelledOrders, liveOrders] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.customer.count(),
    prisma.order.count(),
    prisma.order.count({ where: { status: "cancelled" } }),
    prisma.order.findMany({
      where: { status: { not: "cancelled" } },
      select: {
        externalWarehouse: true, skipVnWeighing: true,
        items: { select: { unitPriceJpy: true } },
        trackings: { select: { packedAt: true, needsTax: true, taxCollected: true, jpWeightKg: true, vnWeightKg: true } },
      },
    }),
  ]);
  const completedOrders = liveOrders.filter(isOrderComplete).length;
  return {
    totalOrders,
    customers,
    completedOrders,
    inProgressOrders: liveOrders.length - completedOrders,
    cancelledOrders,
    byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
  };
}

// ===== Biểu đồ Dashboard: N tháng gần nhất theo tháng lịch VN của order_date (khớp summary danh sách đơn) =====
export const STATUS_GROUPS = {
  waiting: ["draft", "quoted", "deposited", "purchasing"],
  shipping: ["purchased", "jp_warehouse", "customs", "tax_done", "vn_warehouse"],
  done: ["delivered", "completed", "closed"],
  cancelled: ["cancelled"],
} as const;

export type MonthlyStat = {
  month: string; waiting: number; shipping: number; done: number; cancelled: number;
  revenueVnd?: number; spendJpy?: number;
};

// Danh sách "YYYY-MM" liên tục, cũ -> mới, kết thúc ở tháng hiện tại (giờ VN).
export function lastMonthKeys(count: number, now = new Date()): string[] {
  const cur = vnMonthKey(now);
  const [y, m] = cur.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - (count - 1 - i), 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
}

export function parseMonthsParam(q: unknown): number {
  const n = Number(q ?? 12);
  return Number.isInteger(n) ? Math.min(24, Math.max(1, n)) : 12;
}

// Tiền (doanh thu VND, chi JPY) chỉ trả khi caller có orders.read - stats.view cấp cả cho kho/giao hàng.
export async function getMonthly(months: number, withMoney: boolean): Promise<MonthlyStat[]> {
  const keys = lastMonthKeys(months);
  const since = vnMonthRange(keys[0]).start;
  const [counts, spend] = await Promise.all([
    prisma.$queryRaw<{ month: string; waiting: number; shipping: number; done: number; cancelled: number; revenue: string }[]>`
      SELECT to_char(o.order_date + interval '7 hours', 'YYYY-MM') AS month,
        COUNT(*) FILTER (WHERE o.status::text = ANY(${[...STATUS_GROUPS.waiting]}))::int AS waiting,
        COUNT(*) FILTER (WHERE o.status::text = ANY(${[...STATUS_GROUPS.shipping]}))::int AS shipping,
        COUNT(*) FILTER (WHERE o.status::text = ANY(${[...STATUS_GROUPS.done]}))::int AS done,
        COUNT(*) FILTER (WHERE o.status::text = 'cancelled')::int AS cancelled,
        COALESCE(SUM(o.total_vnd) FILTER (WHERE o.status::text <> 'cancelled'), 0)::text AS revenue
      FROM orders o WHERE o.order_date >= ${since}
      GROUP BY 1`,
    withMoney
      ? prisma.$queryRaw<{ month: string; total: string }[]>`
        SELECT to_char(o.order_date + interval '7 hours', 'YYYY-MM') AS month,
          COALESCE(SUM(i.unit_price_jpy * i.qty + COALESCE(i.ship_jpy, 0)), 0)::text AS total
        FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.order_date >= ${since} AND o.status::text <> 'cancelled'
        GROUP BY 1`
      : Promise.resolve([]),
  ]);
  const byMonth = new Map(counts.map((r) => [r.month, r]));
  const spendBy = new Map(spend.map((r) => [r.month, Number(r.total)]));
  return keys.map((month) => {
    const r = byMonth.get(month);
    const row: MonthlyStat = {
      month,
      waiting: Number(r?.waiting ?? 0), shipping: Number(r?.shipping ?? 0),
      done: Number(r?.done ?? 0), cancelled: Number(r?.cancelled ?? 0),
    };
    if (withMoney) { row.revenueVnd = Number(r?.revenue ?? 0); row.spendJpy = spendBy.get(month) ?? 0; }
    return row;
  });
}
