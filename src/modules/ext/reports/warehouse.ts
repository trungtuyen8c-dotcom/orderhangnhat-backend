// Report warehouse_* - copy logic từ warehouse.routes.ts (đọc-only, không import file đó).
import { prisma } from "../../../db.js";
import { dayKey, effKg, cartonWeightLocked } from "../helpers.js";

export async function warehouse_vn_board(params: { customer?: string }) {
  const trkSelect = {
    id: true, code: true, cartonId: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, customsName: true,
    order: { select: { code: true, customer: { select: { name: true } } } },
  } as const;
  const boardWhere = { status: { not: "stored" as const }, OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], NOT: { order: { OR: [{ externalWarehouse: true }, { skipVnWeighing: true }] } } };
  const customerQ = (params.customer ?? "").trim();
  const customerFilter = customerQ ? { order: { customer: { name: { contains: customerQ, mode: "insensitive" as const } } } } : {};
  const [cartons, loose] = await Promise.all([
    prisma.carton.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        trackings: { where: { ...boardWhere, ...customerFilter }, select: trkSelect, orderBy: [{ packedAt: "asc" }, { packRow: "asc" }] },
        _count: { select: { trackings: true } },
      },
    }),
    prisma.tracking.findMany({ where: { packedAt: { not: null }, cartonId: null, ...boardWhere, ...customerFilter }, select: trkSelect, orderBy: [{ packedAt: "desc" }, { packRow: "asc" }] }),
  ]);
  type Day = { day: string; cartons: any[]; unassigned: any[] };
  const days = new Map<string, Day>();
  const getDay = (k: string) => { let d = days.get(k); if (!d) { d = { day: k, cartons: [], unassigned: [] }; days.set(k, d); } return d; };
  const NO_DAY = "0000-00-00";

  for (const c of cartons) {
    const tDays = c.trackings.map((t) => dayKey(t.packedAt)).filter(Boolean) as string[];
    const k = dayKey(c.packedDate) ?? (tDays.length ? tDays.sort()[0] : NO_DAY);
    const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : null;
    const vnTotalWeightKg = c.vnTotalWeightKg != null ? Number(c.vnTotalWeightKg) : null;
    const actualKg = Number(c.trackings.reduce((s, t) => s + effKg(t), 0).toFixed(3));
    getDay(k).cartons.push({
      id: c.id, code: c.code, note: c.note, declaredWeightKg: declared, electronicsCount: c.electronicsCount,
      electronicsConfirmedAt: c.electronicsConfirmedAt,
      vnTotalWeightKg, weightConfirmedAt: c.weightConfirmedAt, weightLocked: cartonWeightLocked(c),
      actualKg, count: c.trackings.length, everAssignedCount: c._count.trackings,
      diffKg: declared != null ? Number((actualKg - declared).toFixed(3)) : null,
      trackings: c.trackings,
    });
  }
  for (const t of loose) getDay(dayKey(t.packedAt)!).unassigned.push(t);

  for (const d of days.values()) d.cartons = d.cartons.filter((c) => c.count > 0 || c.everAssignedCount === 0);
  return [...days.values()].filter((d) => d.cartons.length > 0 || d.unassigned.length > 0).sort((a, b) => (a.day < b.day ? 1 : -1));
}

export function warehouse_stored(params: { customer?: string }) {
  const customerQ = (params.customer ?? "").trim();
  const customerFilter = customerQ ? { order: { customer: { name: { contains: customerQ, mode: "insensitive" as const } } } } : {};
  return prisma.tracking.findMany({
    where: { status: "stored", OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], ...customerFilter },
    orderBy: { storedAt: "asc" }, take: 500,
    select: {
      id: true, code: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, storedAt: true,
      carton: { select: { code: true } }, order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
}

export function warehouse_history(params: { date?: string; vnTrackingCode?: string; code?: string }) {
  const date = (params.date ?? "").trim();
  const vnCode = (params.vnTrackingCode ?? "").trim();
  const jpCode = (params.code ?? "").trim();
  const where: Record<string, unknown> = { packedAt: { not: null } };
  if (date) { const d = new Date(date); where.packedAt = { gte: d, lt: new Date(d.getTime() + 86400000) }; }
  if (vnCode) where.vnTrackingCode = { contains: vnCode, mode: "insensitive" };
  if (jpCode) where.code = { contains: jpCode, mode: "insensitive" };
  return prisma.tracking.findMany({
    where, orderBy: { packedAt: "desc" }, take: 200,
    select: {
      id: true, code: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, deliveredAt: true,
      storedAt: true, customerReceivedAt: true,
      carton: { select: { code: true } }, order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
}

export function warehouse_recon() {
  return prisma.weightRecon.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
}
