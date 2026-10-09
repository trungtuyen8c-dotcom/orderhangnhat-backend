import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";
import { vnMonthKey } from "../../app/vnTime.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { lockOrder, writeAudit } from "../accounting/accounting.repository.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; requestId?: string };

export const mk = vnMonthKey;
const KIND_LABEL: Record<string, string> = {
  chakubarai: "着払い / DAIBIKI (kho ứng hộ)", weight: "Tiền cân tháng", other: "Khác",
  payment: "Đã chuyển trả công ty vận chuyển", daibiki_topup: "Cọc DAIBIKI cho kho",
};
// Khoản trả tiền (giảm nợ), không phải chi phí.
const PAYMENT_KINDS = new Set(["payment", "daibiki_topup"]);
const REINFORCE_KEY = "reinforce_price_vnd";
const ELECTRONICS_KEY = "electronics_price_vnd";
// Đơn giá cân công ty vận chuyển (Global) tính cho mình, ₫/kg theo tuyến. Biển chưa đặt -> báo thiếu, không đoán.
const GLOBAL_AIR_KEY = "global_price_air_vnd";
const GLOBAL_SEA_KEY = "global_price_sea_vnd";

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

export async function globalPrices(): Promise<{ air: number | null; sea: number | null }> {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: [GLOBAL_AIR_KEY, GLOBAL_SEA_KEY] } } });
  const v = (k: string) => { const r = rows.find((x) => x.key === k)?.value; return r ? Number(r) : null; };
  return { air: v(GLOBAL_AIR_KEY), sea: v(GLOBAL_SEA_KEY) };
}
export async function setGlobalPrices(p: { air?: number | null; sea?: number | null }) {
  for (const [key, val] of [[GLOBAL_AIR_KEY, p.air], [GLOBAL_SEA_KEY, p.sea]] as const) {
    if (val === undefined) continue;
    if (val === null) await prisma.appConfig.deleteMany({ where: { key } });
    else await setUnit(key, val);
  }
  return globalPrices();
}

// Kiện của tháng (dựa theo packedDate - ngày kho Nhật đóng) - dùng chung cho phụ thu điện tử + đối soát cân theo ngày.
async function cartonsOfMonth(month: string) {
  const cartons = await prisma.carton.findMany({
    where: { packedDate: { not: null } },
    select: { id: true, code: true, route: true, packedDate: true, declaredWeightKg: true, vnTotalWeightKg: true, electronicsCount: true },
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
  // Tiền cân công ty vận chuyển: cân thùng (declaredWeightKg - cân họ tính phí) x đơn giá theo tuyến.
  const prices = await globalPrices();
  const kg = { air: 0, sea: 0 };
  for (const c of cartonsThisMonth) kg[c.route === "sea" ? "sea" : "air"] += Number(c.declaredWeightKg ?? 0);
  const weightAirVnd = prices.air != null ? Math.round(kg.air * prices.air) : null;
  const weightSeaVnd = prices.sea != null ? Math.round(kg.sea * prices.sea) : null;
  const globalWeight = {
    airKg: Number(kg.air.toFixed(2)), seaKg: Number(kg.sea.toFixed(2)), airPrice: prices.air, seaPrice: prices.sea,
    airVnd: weightAirVnd, seaVnd: weightSeaVnd,
    // Có kg mà chưa có đơn giá -> chưa tính được, hiện cảnh báo thay vì coi như 0.
    missingPrice: (kg.air > 0 && prices.air == null) || (kg.sea > 0 && prices.sea == null),
  };

  // 2 sổ riêng với công ty vận chuyển:
  // - ₫ (bảng TUYẾN): cân + điện tử + gia cố + khoản ₫ nhập tay - các lần chuyển khoản trả (kind=payment).
  // - ¥ (bảng DAIBIKI): COD/着払い ¥ kho ứng hộ - các lần cọc DAIBIKI (kind=daibiki_topup).
  const isJpyCod = (e: (typeof ser)[number]) => (e.kind === "chakubarai" || e.kind === "daibiki_topup") && e.currency === "JPY";
  const byKind: Record<string, number> = { reinforce: reinforceVnd, electronics: electronicsVnd, globalWeight: (weightAirVnd ?? 0) + (weightSeaVnd ?? 0) };
  for (const e of ser) if (!PAYMENT_KINDS.has(e.kind) && !isJpyCod(e)) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amountVnd;
  const costEntriesVnd = ser.filter((e) => !PAYMENT_KINDS.has(e.kind) && !isJpyCod(e)).reduce((s, e) => s + e.amountVnd, 0);
  const totalVnd = reinforceVnd + electronicsVnd + byKind.globalWeight + costEntriesVnd;
  const transferredVnd = ser.filter((e) => e.kind === "payment").reduce((s, e) => s + e.amountVnd, 0);
  const paidVnd = transferredVnd + ser.filter((e) => e.paid && !PAYMENT_KINDS.has(e.kind) && !isJpyCod(e)).reduce((s, e) => s + e.amountVnd, 0);
  const codJpy = ser.filter((e) => e.kind === "chakubarai" && e.currency === "JPY").reduce((s, e) => s + e.amountOrig, 0);
  const topupJpy = ser.filter((e) => e.kind === "daibiki_topup" && e.currency === "JPY").reduce((s, e) => s + e.amountOrig, 0);

  return {
    month, reinforceCount, reinforceUnit: unit, reinforceVnd,
    electronicsCount, electronicsUnit: eUnit, electronicsVnd, globalWeight,
    entries: ser, byKind, totalVnd, transferredVnd, paidVnd, unpaidVnd: totalVnd - paidVnd,
    daibiki: { codJpy, topupJpy, balanceJpy: codJpy - topupJpy },
  };
}

// Đối soát cân theo ngày đóng (giống tab "Quy đổi" + "Cân thực tế" của file Nhận hàng):
// - declaredKg: cân thùng công ty vận chuyển tính phí; splitKg: tổng cân VN chia cho từng tracking trong thùng;
//   diffKg = splitKg - declaredKg (âm = mình trả cân nhiều hơn tính được cho khách).
// - costVnd: tiền cân phải trả = declaredKg x đơn giá theo tuyến (biển chưa có giá -> null).
// - Hàng không có đơn (tracking mồ côi đóng trong tháng): cân + tiền cân tương ứng (mất/sai tracking, hàng VC chưa gán).
export async function settlement(month: string) {
  const eUnit = await electronicsUnit();
  const prices = await globalPrices();
  const cartons = await cartonsOfMonth(month);
  const trks = cartons.length
    ? await prisma.tracking.findMany({ where: { cartonId: { in: cartons.map((c) => c.id) } }, select: { cartonId: true, vnWeightKg: true, jpWeightKg: true, orderId: true } })
    : [];
  const splitByCarton = new Map<string, number>();
  for (const t of trks) splitByCarton.set(t.cartonId!, (splitByCarton.get(t.cartonId!) ?? 0) + Number(t.vnWeightKg ?? 0));
  const priceOf = (route: string) => (route === "sea" ? prices.sea : prices.air);

  type Day = { date: string; cartons: number; declaredKg: number; vnKg: number; splitKg: number; electronicsCount: number; costVnd: number | null };
  const byDay = new Map<string, Day>();
  for (const c of cartons) {
    const day = c.packedDate.toISOString().slice(0, 10);
    const row = byDay.get(day) ?? { date: day, cartons: 0, declaredKg: 0, vnKg: 0, splitKg: 0, electronicsCount: 0, costVnd: 0 };
    const declared = c.declaredWeightKg != null ? Number(c.declaredWeightKg) : 0;
    row.cartons += 1;
    row.declaredKg += declared;
    row.vnKg += c.vnTotalWeightKg != null ? Number(c.vnTotalWeightKg) : 0;
    row.splitKg += splitByCarton.get(c.id) ?? 0;
    row.electronicsCount += c.electronicsCount ?? 0;
    const p = priceOf(c.route);
    row.costVnd = row.costVnd == null || (declared && p == null) ? null : row.costVnd + declared * (p ?? 0);
    byDay.set(day, row);
  }
  const r2 = (n: number) => Number(n.toFixed(2));
  const rows = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((r) => ({
    date: r.date, cartons: r.cartons, declaredKg: r2(r.declaredKg), vnKg: r2(r.vnKg), splitKg: r2(r.splitKg), diffKg: r2(r.splitKg - r.declaredKg),
    electronicsCount: r.electronicsCount, electronicsVnd: r.electronicsCount * eUnit, costVnd: r.costVnd == null ? null : Math.round(r.costVnd),
  }));

  // Hàng đóng trong tháng nhưng chưa có đơn (mồ côi) - tiền cân đã trả mà chưa thu được của ai.
  const orphans = (await prisma.tracking.findMany({
    where: { orderId: null, packedAt: { not: null } },
    select: { code: true, packedAt: true, vnWeightKg: true, jpWeightKg: true, carton: { select: { route: true } } },
  })).filter((t) => t.packedAt && mk(t.packedAt) === month);
  const orphanKg = orphans.reduce((s, t) => s + Number(t.vnWeightKg ?? t.jpWeightKg ?? 0), 0);
  // Có cân mà tuyến đó chưa có đơn giá -> null (báo thiếu giá), giống tiền cân kiện - không coi như 0đ.
  const orphanPriceMissing = orphans.some((t) => Number(t.vnWeightKg ?? t.jpWeightKg ?? 0) > 0 && priceOf(t.carton?.route ?? "air") == null);
  const orphanVnd = orphanPriceMissing ? null : orphans.reduce((s, t) => s + Number(t.vnWeightKg ?? t.jpWeightKg ?? 0) * (priceOf(t.carton?.route ?? "air") ?? 0), 0);

  return {
    month, rows, prices,
    totalCartons: rows.reduce((s, r) => s + r.cartons, 0),
    totalDeclaredKg: r2(rows.reduce((s, r) => s + r.declaredKg, 0)),
    totalVnKg: r2(rows.reduce((s, r) => s + r.vnKg, 0)),
    totalSplitKg: r2(rows.reduce((s, r) => s + r.splitKg, 0)),
    totalDiffKg: r2(rows.reduce((s, r) => s + r.diffKg, 0)),
    totalCostVnd: rows.some((r) => r.costVnd == null) ? null : rows.reduce((s, r) => s + (r.costVnd ?? 0), 0),
    totalElectronicsCount: rows.reduce((s, r) => s + r.electronicsCount, 0),
    totalElectronicsVnd: rows.reduce((s, r) => s + r.electronicsVnd, 0),
    orphan: { count: orphans.length, kg: r2(orphanKg), vnd: orphanVnd == null ? null : Math.round(orphanVnd), codes: orphans.slice(0, 200).map((t) => t.code) },
  };
}

export type EntryInput = {
  kind: "chakubarai" | "weight" | "other" | "payment" | "daibiki_topup";
  month: string;
  amount: number;
  currency: "VND" | "JPY";
  exchangeRate?: number;
  note?: string;
  trackingCode?: string;
  orderCode?: string;
};

const bad = (message: string) => new AppError("BAD_REQUEST", 400, message);

// 着払い: tìm tracking gắn khoản này - theo mã tracking, hoặc theo mã đơn nếu đơn có ĐÚNG 1 tracking.
async function resolveChakubaraiTracking(tx: Tx, trackingCode?: string, orderCode?: string): Promise<string | null> {
  const code = trackingCode?.trim();
  const oc = orderCode?.trim();
  if (code) {
    const trk = await tx.tracking.findFirst({ where: { code }, select: { id: true } });
    if (trk) return trk.id;
    // Khách tự mang hàng tới kho trả COD (chưa có đơn): tạo tracking mồ côi giữ khoản này - gán khách/đơn sau
    // thì COD tự vào công nợ + sheet khách (gán tracking -> recomputeOrderTotals).
    const orphan = await tx.tracking.create({ data: { id: uuid(), code, status: "new" } });
    return orphan.id;
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
  // COD/DAIBIKI ¥ giữ nguyên yên (sổ ¥ với kho; khách yên trả ¥, khách ₫ quy theo tỉ giá đơn) -> không bắt tỉ giá.
  const jpyAllowed = input.kind === "chakubarai" || input.kind === "daibiki_topup";
  if (input.currency === "JPY" && !input.exchangeRate && !jpyAllowed) throw bad("Nhập JPY cần tỉ giá");
  const amountVnd = input.currency === "JPY" ? Math.round(input.amount * (input.exchangeRate ?? 0)) : input.amount;

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
    if (!c) throw new AppError("NOT_FOUND", 404);
    return tx.companyCost.update({ where: { id: c.id }, data: { paid: !c.paid } });
  });
}

export async function deleteEntry(id: string, actor: Actor) {
  const customerId = await prisma.$transaction(async (tx) => {
    const c = await tx.companyCost.findUnique({ where: { id } });
    if (!c) throw new AppError("NOT_FOUND", 404);
    await tx.companyCost.delete({ where: { id } });
    // Gắn tracking (着払い) -> xóa khoản này phải tự trừ lại công nợ + sheet khách, không được giữ nguyên số cũ.
    const cid = c.refId ? await applyTrackingCost(tx, c.refId) : null;
    await writeAudit(tx, { actorId: actor.id, targetId: id, action: "company_cost.deleted", requestId: actor.requestId });
    return cid;
  });
  if (customerId) await queueCustomerSheetSync(customerId);
  return { ok: true };
}
