import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { vnMonthKey } from "../../app/vnTime.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { lockOrder, writeAudit } from "../accounting/accounting.repository.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; requestId?: string };

export const mk = vnMonthKey;
const KIND_LABEL: Record<string, string> = { chakubarai: "着払い (hàng trả sau)", weight: "Tiền cân tháng", other: "Khác" };
const REINFORCE_KEY = "reinforce_price_vnd";
const ELECTRONICS_KEY = "electronics_price_vnd";

export const monthOrCurrent = (m: unknown) => (typeof m === "string" && /^\d{4}-\d{2}$/.test(m) ? m : mk(new Date()));

export async function reinforceUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: REINFORCE_KEY } });
  return Number(c?.value ?? 30000);
}
export async function electronicsUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: ELECTRONICS_KEY } });
  return Number(c?.value ?? 0);
}
async function setUnit(key: string, unit: number) {
  await prisma.appConfig.upsert({ where: { key }, update: { value: String(unit) }, create: { key, value: String(unit) } });
  return { unit };
}
export const setReinforceUnit = (unit: number) => setUnit(REINFORCE_KEY, unit);
export const setElectronicsUnit = (unit: number) => setUnit(ELECTRONICS_KEY, unit);

// Kiện của tháng (dựa theo packedDate - ngày kho Nhật đóng) - dùng chung cho phụ thu điện tử + đối soát cân theo ngày.
async function cartonsOfMonth(month: string) {
  const cartons = await prisma.carton.findMany({
    where: { packedDate: { not: null } },
    select: { packedDate: true, declaredWeightKg: true, vnTotalWeightKg: true, electronicsCount: true },
  });
  return cartons.filter((c) => c.packedDate && mk(c.packedDate) === month) as (typeof cartons[number] & { packedDate: Date })[];
}

// Báo cáo phải trả kho/cty theo tháng
export async function report(month: string) {
  const unit = await reinforceUnit();

  // Gia cố/check: đếm đơn needsCheck có tracking đóng hàng trong tháng
  const checkTrks = await prisma.tracking.findMany({
    where: { packedAt: { not: null }, order: { needsCheck: true } },
    select: { packedAt: true, orderId: true },
  });
  const reinforceOrders = new Set<string>();
  for (const t of checkTrks) if (t.packedAt && mk(t.packedAt) === month && t.orderId) reinforceOrders.add(t.orderId);
  const reinforceCount = reinforceOrders.size;
  const reinforceVnd = reinforceCount * unit;

  // Phụ thu công ty đếm hàng điện tử - đếm/tổng hợp theo kiện đóng trong tháng
  const eUnit = await electronicsUnit();
  const cartonsThisMonth = await cartonsOfMonth(month);
  const electronicsCount = cartonsThisMonth.reduce((s, c) => s + (c.electronicsCount ?? 0), 0);
  const electronicsVnd = electronicsCount * eUnit;

  // Entry nhập tay (chakubarai, weight, other)
  const entries = await prisma.companyCost.findMany({ where: { month }, orderBy: { createdAt: "desc" } });
  // Khoản 着払い gắn tracking -> tra ngược đơn/khách để hiện cho biết đã tính vào công nợ ai
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

// Đối soát cân theo ngày (kho Nhật khai báo vs VN nhập tay) để thanh toán tiền cân cho công ty vận chuyển -
// thanh toán theo cân kho Nhật, cân VN chỉ để đối chiếu/tham khảo.
export async function settlement(month: string) {
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

export type EntryInput = {
  kind: "chakubarai" | "weight" | "other";
  month: string;
  amount: number;
  currency: "VND" | "JPY";
  exchangeRate?: number;
  note?: string;
  trackingCode?: string;
  orderCode?: string;
};

const bad = (message: string) => new LegacyError(400, "BAD_REQUEST", message);

// 着払い: tìm tracking gắn khoản này - theo mã tracking, hoặc theo mã đơn nếu đơn có ĐÚNG 1 tracking.
async function resolveChakubaraiTracking(tx: Tx, trackingCode?: string, orderCode?: string): Promise<string | null> {
  const code = trackingCode?.trim();
  const oc = orderCode?.trim();
  if (code) {
    const trk = await tx.tracking.findFirst({ where: { code }, select: { id: true, orderId: true } });
    if (!trk) throw bad("Không tìm thấy mã tracking này");
    if (!trk.orderId) throw bad("Mã tracking chưa gắn đơn nào");
    return trk.id;
  }
  if (oc) {
    const order = await tx.order.findUnique({ where: { code: oc }, select: { trackings: { select: { id: true } } } });
    if (!order) throw bad("Không tìm thấy mã đơn này");
    if (!order.trackings.length) throw bad("Đơn chưa có tracking nào");
    if (order.trackings.length > 1) throw bad("Đơn có nhiều tracking - nhập đúng mã tracking để xác định");
    return order.trackings[0].id;
  }
  return null;
}

// Khoản 着払い gắn tracking -> đơn/khách: tính lại tổng đơn + công nợ trong CÙNG transaction.
// Trả về customerId để sync sheet khách SAU commit.
async function applyTrackingCost(tx: Tx, trackingId: string): Promise<string | null> {
  const t = await tx.tracking.findUnique({ where: { id: trackingId }, select: { orderId: true } });
  if (!t?.orderId) return null;
  const order = await lockOrder(tx, t.orderId);
  if (!order) return null;
  await recomputeOrderTotals(t.orderId, tx);
  return order.customerId;
}

export async function createEntry(input: EntryInput, actor: Actor) {
  if (input.currency === "JPY" && !input.exchangeRate) throw bad("Nhập JPY cần tỉ giá");
  const amountVnd = input.currency === "JPY" ? Math.round(input.amount * input.exchangeRate!) : input.amount;

  const { cost, customerId } = await prisma.$transaction(async (tx) => {
    const refId = input.kind === "chakubarai" ? await resolveChakubaraiTracking(tx, input.trackingCode, input.orderCode) : null;

    // Điền sau khi ngày đóng hàng của tracking đã bị chốt hải quan -> không tự vào invoice ngày đó nữa, đánh dấu để biết cần khai bổ sung.
    let lateAfterLock = false;
    if (refId) {
      const trk = await tx.tracking.findUnique({ where: { id: refId }, select: { packedAt: true } });
      if (trk?.packedAt) {
        const dayStr = trk.packedAt.toISOString().slice(0, 10);
        const lock = await tx.packDayLock.findUnique({ where: { date: new Date(`${dayStr}T00:00:00`) } });
        lateAfterLock = !!lock;
      }
    }

    const cost = await tx.companyCost.create({ data: {
      id: uuid(), kind: input.kind, month: input.month, amountVnd, currency: input.currency,
      amountOrig: input.amount, exchangeRate: input.exchangeRate ?? null, note: input.note ?? null, refId, lateAfterLock,
    } });
    const customerId = refId ? await applyTrackingCost(tx, refId) : null;
    await writeAudit(tx, {
      actorId: actor.id, targetId: cost.id, action: "company_cost.created", requestId: actor.requestId,
      metadata: { kind: cost.kind, amountVnd, refId, lateAfterLock },
    });
    return { cost, customerId };
  });

  if (customerId) await queueCustomerSheetSync(customerId);
  return cost;
}

export async function togglePaid(id: string) {
  return prisma.$transaction(async (tx) => {
    const c = await tx.companyCost.findUnique({ where: { id } });
    if (!c) throw new LegacyError(404, "NOT_FOUND");
    return tx.companyCost.update({ where: { id: c.id }, data: { paid: !c.paid } });
  });
}

export async function deleteEntry(id: string, actor: Actor) {
  const customerId = await prisma.$transaction(async (tx) => {
    const c = await tx.companyCost.findUnique({ where: { id } });
    if (!c) throw new LegacyError(404, "NOT_FOUND");
    await tx.companyCost.delete({ where: { id } });
    // Gắn tracking (着払い) -> xóa khoản này phải tự trừ lại công nợ + sheet khách, không được giữ nguyên số cũ.
    const cid = c.refId ? await applyTrackingCost(tx, c.refId) : null;
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "company_cost.deleted", requestId: actor.requestId });
    return cid;
  });
  if (customerId) await queueCustomerSheetSync(customerId);
  return { ok: true };
}
