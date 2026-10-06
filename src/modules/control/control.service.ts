import { effKg } from "../tracking/tracking.weight.js";
import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { eventBus } from "../../app/events/EventBus.js";

export type Actor = { id: string; requestId?: string };

export { effKg };

// ===== Kiện / carton: đối soát cân =====

export async function listCartons() {
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

export type CartonInput = { code: string; declaredWeightKg?: number; electronicsCount?: number; packedDate?: string; note?: string };

export async function createCarton(input: CartonInput, actor: Actor) {
  const c = await prisma.carton.create({ data: {
    id: uuid(), code: input.code, declaredWeightKg: input.declaredWeightKg ?? null, electronicsCount: input.electronicsCount ?? null,
    packedDate: input.packedDate ? new Date(input.packedDate) : null, note: input.note ?? null,
  } });
  await logAudit({ actorId: actor.id, targetId: c.id, action: "carton.created", requestId: actor.requestId });
  eventBus.publish({ eventName: "carton.created", actorId: actor.id, entityType: "carton", entityId: c.id, metadata: { code: c.code } });
  return c;
}

export function updateCarton(id: string, input: Partial<CartonInput>) {
  const { packedDate, ...rest } = input;
  return prisma.carton.update({
    where: { id },
    // Sửa lại cân tổng kho Nhật -> xác nhận lệch cân cũ (nếu có) không còn hiệu lực, phải xác nhận lại.
    data: {
      ...rest,
      ...(rest.declaredWeightKg !== undefined ? { weightConfirmedAt: null } : {}),
      ...(rest.electronicsCount !== undefined ? { electronicsConfirmedAt: null } : {}),
      ...(packedDate !== undefined ? { packedDate: packedDate ? new Date(packedDate) : null } : {}),
    },
  });
}

export async function deleteCarton(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    // Đánh dấu manual để không bị sync kho tự gán lại (tạo lại) kiện vừa xóa ngay sau đó.
    await tx.tracking.updateMany({ where: { cartonId: id }, data: { cartonId: null, cartonManual: true } });
    await tx.carton.delete({ where: { id } });
  });
  await logAudit({ actorId: actor.id, targetId: id, action: "carton.deleted", requestId: actor.requestId });
  return { ok: true };
}

// Gán tracking vào kiện theo mã (dán nhiều mã, mỗi dòng 1 mã)
export async function assignToCarton(id: string, rawCodes: string[]) {
  const carton = await prisma.carton.findUnique({ where: { id } });
  if (!carton) throw new LegacyError(404, "NOT_FOUND");
  const codes = rawCodes.map((c) => c.trim()).filter(Boolean);
  const r = await prisma.tracking.updateMany({ where: { code: { in: codes } }, data: { cartonId: carton.id, cartonManual: true } });
  return { assigned: r.count };
}

// ===== Tracking về VN chưa khớp đơn =====

export function listUnmatched() {
  return prisma.tracking.findMany({
    where: { orderId: null },
    orderBy: { createdAt: "desc" }, take: 500,
    select: { id: true, code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, review: true, createdAt: true },
  });
}

// ===== Công nợ quá hạn / ngưỡng =====

export async function getDebtConfig() {
  const rows = await prisma.appConfig.findMany({ where: { key: { in: ["debt_threshold_vnd", "debt_overdue_days"] } } });
  const m = new Map(rows.map((r) => [r.key, r.value]));
  return { thresholdVnd: Number(m.get("debt_threshold_vnd") ?? 0), overdueDays: Number(m.get("debt_overdue_days") ?? 30) };
}

export async function setDebtConfig(cfg: { thresholdVnd: number; overdueDays: number }) {
  await prisma.$transaction([
    prisma.appConfig.upsert({ where: { key: "debt_threshold_vnd" }, update: { value: String(cfg.thresholdVnd) }, create: { key: "debt_threshold_vnd", value: String(cfg.thresholdVnd) } }),
    prisma.appConfig.upsert({ where: { key: "debt_overdue_days" }, update: { value: String(cfg.overdueDays) }, create: { key: "debt_overdue_days", value: String(cfg.overdueDays) } }),
  ]);
  return cfg;
}

// Gộp nợ theo khách + tiền tệ - KHÔNG lọc where:{currency:"VND"} như trước (bỏ sót hoàn toàn khách nợ ¥
// khi đơn chưa có tỉ giá - computeDebtBalance cố ý giữ nợ theo ¥ trong trường hợp đó, không quy đổi ẩu).
// Ngưỡng số tiền (thresholdVnd) chỉ áp dụng được cho nợ ₫; nợ ¥ chỉ xét theo số ngày quá hạn.
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

export async function overdueDebts() {
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

// ===== Hàng "Lưu kho" nằm quá lâu chưa ship =====

export async function getStorageConfig() {
  const row = await prisma.appConfig.findUnique({ where: { key: "storage_overdue_days" } });
  return { overdueDays: Number(row?.value ?? 7) };
}

export async function setStorageConfig(cfg: { overdueDays: number }) {
  await prisma.appConfig.upsert({ where: { key: "storage_overdue_days" }, update: { value: String(cfg.overdueDays) }, create: { key: "storage_overdue_days", value: String(cfg.overdueDays) } });
  return cfg;
}

export async function storageOverdueCount(): Promise<number> {
  const cfg = await getStorageConfig();
  const cut = new Date(Date.now() - cfg.overdueDays * 86400000);
  // Tuổi tồn kho tính theo storedAt (ngày bấm "Chuyển lưu kho" - đúng mốc hàng bắt đầu nằm chờ ở kho VN).
  // Bản ghi cũ trước khi có field này chưa có storedAt -> tạm dùng packedAt làm mốc dự phòng.
  return prisma.tracking.count({
    where: {
      status: "stored",
      OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }],
      AND: [{ OR: [{ storedAt: { lt: cut } }, { AND: [{ storedAt: null }, { packedAt: { lt: cut } }] }] }],
      NOT: { order: { externalWarehouse: true } },
    },
  });
}

// ===== Trung tâm kiểm soát: gom số đếm =====

export async function overview() {
  // Đơn quá 5 ngày chưa có tracking nào - tách riêng theo 3 loại web (nguồn khác nhau, người xử lý khác nhau).
  const lateCut = new Date(Date.now() - 5 * 86400000);
  const lateOrdersBySource = (source: string) => prisma.order.count({ where: { status: { not: "cancelled" }, source, trackings: { none: {} }, createdAt: { lt: lateCut } } });
  const [lateOrdersMercari, lateOrdersYahoo, lateOrdersNormal, notReviewed, pendingDeposits, unmatched, missingPrice, cartons, overdue, storageOverdue, lateAfterLock, taxPendingTracking, taxPendingName] = await Promise.all([
    lateOrdersBySource("mercari"), lateOrdersBySource("yahoo"), lateOrdersBySource("normal"),
    prisma.tracking.count({ where: { review: null, orderId: { not: null } } }),
    prisma.customerDeposit.count({ where: { confirmed: false } }),
    prisma.tracking.count({ where: { orderId: null } }),
    // totalVnd=null cũng xảy ra khi khách trả thẳng ¥ (chưa có tỉ giá, cố ý) -> không tính là thiếu giá.
    // Chỉ đếm đơn thật sự chưa điền đơn giá món hàng (unitPriceJpy=0).
    prisma.order.count({ where: { status: { not: "cancelled" }, items: { some: { unitPriceJpy: 0 } } } }),
    prisma.carton.findMany({ where: { declaredWeightKg: { not: null } }, include: { trackings: { select: { jpWeightKg: true, vnWeightKg: true } } } }),
    overdueDebts(),
    storageOverdueCount(),
    prisma.tracking.count({ where: { lateAfterLock: true } }),
    // Từng khớp dòng vàng "cần lấy thuế" (needsTax) nhưng chưa tick "Đã lấy thuế" - cảnh báo dồn nhiều chuyến chưa thu.
    // Loại tracking chưa gắn đơn (orderId null) - trang Shipments cũng ẩn nhóm này (chưa biết khách/đơn thì
    // chưa xử lý được ở đây), tính vào đây sẽ tạo cảnh báo cụt không có chỗ xử lý.
    prisma.tracking.count({ where: { needsTax: true, taxCollected: false, orderId: { not: null } } }),
    // Dòng khớp theo tên (file GB, không có mã tracking) đã đăng ký lúc quét nhưng chưa tick "Đã lấy thuế".
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
