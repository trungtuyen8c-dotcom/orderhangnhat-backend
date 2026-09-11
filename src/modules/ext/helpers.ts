// Hàm thuần copy lại từ control.routes.ts / warehouse.routes.ts (KHÔNG import file route đó -
// theo đúng yêu cầu module ext hoàn toàn tách biệt). Giữ logic giống hệt bản gốc.

export const effKg = (t: { jpWeightKg: unknown; vnWeightKg: unknown }) =>
  t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);

export const dayKey = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const CARTON_WEIGHT_DIFF_THRESHOLD_KG = 1;
export function cartonWeightLocked(c: { declaredWeightKg: unknown; vnTotalWeightKg: unknown; weightConfirmedAt: Date | null }): boolean {
  const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : null;
  const vnTotal = c.vnTotalWeightKg != null ? Number(c.vnTotalWeightKg) : null;
  if (declared == null || vnTotal == null) return true;
  return Math.abs(declared - vnTotal) >= CARTON_WEIGHT_DIFF_THRESHOLD_KG && !c.weightConfirmedAt;
}

export function summarizeOverdueDebts(
  debtAgg: { customerId: string; currency: string; _sum: { balance: unknown } }[],
  oldest: Map<string, Date>,
  customers: { id: string; name: string; code: string | null; phone: string | null }[],
  cfg: { thresholdVnd: number; overdueDays: number },
  now: number,
) {
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const byCustomer = new Map<string, { balanceVnd: number; balanceJpy: number }>();
  for (const g of debtAgg) {
    const cur = byCustomer.get(g.customerId) ?? { balanceVnd: 0, balanceJpy: 0 };
    const amt = Number(g._sum.balance ?? 0);
    if (g.currency === "JPY") cur.balanceJpy += amt; else cur.balanceVnd += amt;
    byCustomer.set(g.customerId, cur);
  }
  return [...byCustomer.entries()].map(([customerId, { balanceVnd, balanceJpy }]) => {
    const od = oldest.get(customerId);
    const days = od ? Math.floor((now - new Date(od).getTime()) / 86400000) : 0;
    return { customerId, name: cmap.get(customerId)?.name ?? "?", code: cmap.get(customerId)?.code ?? null, phone: cmap.get(customerId)?.phone ?? null, balanceVnd, balanceJpy, days };
  }).filter((r) => (r.balanceVnd > 0 || r.balanceJpy > 0) && (r.balanceVnd >= cfg.thresholdVnd || r.days >= cfg.overdueDays))
    .sort((a, b) => b.balanceVnd - a.balanceVnd || b.balanceJpy - a.balanceJpy);
}

// Giờ VN = UTC+7, copy từ utils/vnTime.ts (file util thuần, không phải route - nhưng để module ext
// không phụ thuộc chéo, giữ bản riêng ở đây, giống hệt logic gốc).
export const vnDayStart = (d: string) => new Date(`${d}T00:00:00+07:00`);
export const vnMonthKey = (d: Date | string) => {
  const vn = new Date(new Date(d).getTime() + 7 * 3600 * 1000);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}`;
};
export function vnMonthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  const start = vnDayStart(`${month}-01`);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = vnDayStart(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
  return { start, end };
}
