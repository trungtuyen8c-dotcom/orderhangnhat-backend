// Report control_* - copy logic từ control.routes.ts (đọc-only, không import file đó).
import { prisma } from "../../../db.js";
import { effKg, summarizeOverdueDebts } from "../helpers.js";

async function getDebtConfig() {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: ["debt_threshold_vnd", "debt_overdue_days"] } } });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return { thresholdVnd: Number(m.get("debt_threshold_vnd") ?? 0), overdueDays: Number(m.get("debt_overdue_days") ?? 30) };
}

async function getStorageConfig() {
  const row = await prisma.appConfig.findUnique({ where: { key: "storage_overdue_days" } });
  return { overdueDays: Number(row?.value ?? 7) };
}

async function storageOverdueCount(): Promise<number> {
  const cfg = await getStorageConfig();
  const cut = new Date(Date.now() - cfg.overdueDays * 86400000);
  return prisma.tracking.count({
    where: {
      status: "stored",
      OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }],
      AND: [{ OR: [{ storedAt: { lt: cut } }, { AND: [{ storedAt: null }, { packedAt: { lt: cut } }] }] }],
      NOT: { order: { externalWarehouse: true } },
    },
  });
}

async function overdueDebts() {
  const cfg = await getDebtConfig();
  const [debtAgg, orders, customers] = await Promise.all([
    prisma.debt.groupBy({ by: ["customerId", "currency"], _sum: { balance: true } }),
    prisma.order.findMany({ where: { status: { not: "cancelled" } }, select: { customerId: true, createdAt: true } }),
    prisma.customer.findMany({ select: { id: true, name: true, code: true, phone: true } }),
  ]);
  const oldest = new Map<string, Date>();
  for (const o of orders) { const cur = oldest.get(o.customerId); if (!cur || o.createdAt < cur) oldest.set(o.customerId, o.createdAt); }
  const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, Date.now());
  return { cfg, list };
}

export async function control_overview() {
  const lateCut = new Date(Date.now() - 5 * 86400000);
  const lateOrdersBySource = (source: string) => prisma.order.count({ where: { status: { not: "cancelled" }, source, trackings: { none: {} }, createdAt: { lt: lateCut } } });
  const [lateOrdersMercari, lateOrdersYahoo, lateOrdersNormal, notReviewed, pendingDeposits, unmatched, missingPrice, cartons, overdue, storageOverdue, lateAfterLock, taxPendingTracking, taxPendingName] = await Promise.all([
    lateOrdersBySource("mercari"), lateOrdersBySource("yahoo"), lateOrdersBySource("normal"),
    prisma.tracking.count({ where: { review: null, orderId: { not: null } } }),
    prisma.customerDeposit.count({ where: { confirmed: false } }),
    prisma.tracking.count({ where: { orderId: null } }),
    prisma.order.count({ where: { status: { not: "cancelled" }, items: { some: { unitPriceJpy: 0 } } } }),
    prisma.carton.findMany({ where: { declaredWeightKg: { not: null } }, include: { trackings: { select: { jpWeightKg: true, vnWeightKg: true } } } }),
    overdueDebts(),
    storageOverdueCount(),
    prisma.tracking.count({ where: { lateAfterLock: true } }),
    prisma.tracking.count({ where: { needsTax: true, taxCollected: false, orderId: { not: null } } }),
    prisma.taxRowNote.count({ where: { trackingCode: { startsWith: "name:" }, taxCollected: false } }),
  ]);
  const cartonMismatch = cartons.filter((c) => {
    const actual = c.trackings.reduce((s, t) => s + effKg(t), 0);
    return Math.abs(actual - Number(c.declaredWeightKg)) > 0.1;
  }).length;
  return {
    lateOrdersMercari, lateOrdersYahoo, lateOrdersNormal, notReviewed, pendingDeposits, unmatched, missingPrice, cartonMismatch,
    overdueDebts: overdue.list.length, storageOverdue, lateAfterLock, taxPending: taxPendingTracking + taxPendingName,
  };
}

export const control_debt_config = () => getDebtConfig();
export const control_overdue_debts = () => overdueDebts();

export async function control_cartons() {
  const cartons = await prisma.carton.findMany({
    orderBy: { createdAt: "desc" },
    include: { trackings: { select: { id: true, code: true, jpWeightKg: true, vnWeightKg: true, order: { select: { code: true } } } } },
  });
  return cartons.map((c) => {
    const actualKg = c.trackings.reduce((s, t) => s + effKg(t), 0);
    const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : null;
    return {
      id: c.id, code: c.code, note: c.note,
      declaredWeightKg: declared, actualKg, count: c.trackings.length,
      diffKg: declared != null ? actualKg - declared : null,
      trackings: c.trackings,
    };
  });
}

export function control_unmatched() {
  return prisma.tracking.findMany({
    where: { orderId: null },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, review: true, createdAt: true },
  });
}
