// Report companycost_* - copy logic từ companycost.routes.ts (đọc-only, không import file đó).
import { prisma } from "../../../db.js";
import { vnMonthKey } from "../helpers.js";

const KIND_LABEL: Record<string, string> = { chakubarai: "着払い (hàng trả sau)", weight: "Tiền cân tháng", other: "Khác" };
const monthOrDefault = (m?: string) => (m && /^\d{4}-\d{2}$/.test(m) ? m : vnMonthKey(new Date()));

async function reinforceUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: "reinforce_price_vnd" } });
  return Number(c?.value ?? 30000);
}
async function electronicsUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: "electronics_price_vnd" } });
  return Number(c?.value ?? 0);
}
async function cartonsOfMonth(month: string) {
  const cartons = await prisma.carton.findMany({
    where: { packedDate: { not: null } },
    select: { packedDate: true, declaredWeightKg: true, vnTotalWeightKg: true, electronicsCount: true },
  });
  return cartons.filter((c) => c.packedDate && vnMonthKey(c.packedDate) === month) as (typeof cartons[number] & { packedDate: Date })[];
}

export async function companycost_report(params: { month?: string }) {
  const month = monthOrDefault(params.month);
  const unit = await reinforceUnit();

  const checkTrks = await prisma.tracking.findMany({
    where: { packedAt: { not: null }, order: { needsCheck: true } },
    select: { packedAt: true, orderId: true },
  });
  const reinforceOrders = new Set<string>();
  for (const t of checkTrks) if (t.packedAt && vnMonthKey(t.packedAt) === month && t.orderId) reinforceOrders.add(t.orderId);
  const reinforceCount = reinforceOrders.size;
  const reinforceVnd = reinforceCount * unit;

  const eUnit = await electronicsUnit();
  const cartonsThisMonth = await cartonsOfMonth(month);
  const electronicsCount = cartonsThisMonth.reduce((s, c) => s + (c.electronicsCount ?? 0), 0);
  const electronicsVnd = electronicsCount * eUnit;

  const entries = await prisma.companyCost.findMany({ where: { month }, orderBy: { createdAt: "desc" } });
  const trkIds = entries.filter((e) => e.kind === "chakubarai" && e.refId).map((e) => e.refId as string);
  const trks = trkIds.length
    ? await prisma.tracking.findMany({ where: { id: { in: trkIds } }, select: { id: true, code: true, order: { select: { code: true, customer: { select: { name: true } } } } } })
    : [];
  const trkMap = new Map(trks.map((t) => [t.id, t]));
  const ser = entries.map((e) => {
    const trk = e.refId ? trkMap.get(e.refId) : undefined;
    return {
      id: e.id, kind: e.kind, kindLabel: KIND_LABEL[e.kind] ?? e.kind, amountVnd: Number(e.amountVnd),
      currency: e.currency, amountOrig: Number(e.amountOrig), exchangeRate: e.exchangeRate ? Number(e.exchangeRate) : null,
      note: e.note, paid: e.paid, createdAt: e.createdAt, lateAfterLock: e.lateAfterLock,
      trackingCode: trk?.code ?? null, orderCode: trk?.order?.code ?? null, customerName: trk?.order?.customer?.name ?? null,
    };
  });
  const byKind: Record<string, number> = { reinforce: reinforceVnd, electronics: electronicsVnd };
  for (const e of ser) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amountVnd;
  const totalVnd = reinforceVnd + electronicsVnd + ser.reduce((s, e) => s + e.amountVnd, 0);
  const paidVnd = ser.filter((e) => e.paid).reduce((s, e) => s + e.amountVnd, 0);

  return {
    month, reinforceCount, reinforceUnit: unit, reinforceVnd,
    electronicsCount, electronicsUnit: eUnit, electronicsVnd,
    entries: ser, byKind, totalVnd, paidVnd, unpaidVnd: totalVnd - paidVnd,
  };
}

export async function companycost_settlement(params: { month?: string }) {
  const month = monthOrDefault(params.month);
  const eUnit = await electronicsUnit();
  const cartons = await cartonsOfMonth(month);
  const byDay = new Map<string, { date: string; declaredKg: number; vnKg: number; electronicsCount: number }>();
  for (const c of cartons) {
    const day = c.packedDate.toISOString().slice(0, 10);
    const row = byDay.get(day) ?? { date: day, declaredKg: 0, vnKg: 0, electronicsCount: 0 };
    row.declaredKg += c.declaredWeightKg != null ? Number(c.declaredWeightKg) : 0;
    row.vnKg += c.vnTotalWeightKg != null ? Number(c.vnTotalWeightKg) : 0;
    row.electronicsCount += c.electronicsCount ?? 0;
    byDay.set(day, row);
  }
  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    date: r.date, declaredKg: Number(r.declaredKg.toFixed(2)), vnKg: Number(r.vnKg.toFixed(2)),
    electronicsCount: r.electronicsCount, electronicsVnd: r.electronicsCount * eUnit,
  }));
  return {
    month, rows,
    totalDeclaredKg: Number(rows.reduce((s, r) => s + r.declaredKg, 0).toFixed(2)),
    totalVnKg: Number(rows.reduce((s, r) => s + r.vnKg, 0).toFixed(2)),
    totalElectronicsCount: rows.reduce((s, r) => s + r.electronicsCount, 0),
    totalElectronicsVnd: rows.reduce((s, r) => s + r.electronicsVnd, 0),
  };
}

export async function companycost_reinforce_price() { return { unit: await reinforceUnit() }; }
export async function companycost_electronics_price() { return { unit: await electronicsUnit() }; }
