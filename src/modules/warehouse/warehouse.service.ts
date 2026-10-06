import { createHash, timingSafeEqual } from "crypto";
import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { loadPermissions } from "../../middlewares/authorize.js";
import { parseSheetId } from "../../integrations/google/googleSheets.client.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { syncPackedFromWarehouse, setDayLockFromTab } from "../sheets/warehouseSheetSync.service.js";
import { syncPackedOne } from "../sheets/warehousePackedOne.service.js";
import { queueCustomerSheetSync, queueTrackingSheetRow, queueWarehouseRowClear } from "../sheets/sheet.jobs.js";
import { cartonWeightLocked, deleteCartonIfEmpty } from "../cartons/carton.service.js";
import { assertTrackingDeletable, queueOrderCustomerSync } from "../tracking/tracking.service.js";
import { claimOrCreateTracking } from "../tracking/tracking.repository.js";
import * as repo from "./warehouse.repository.js";

export type Actor = { id: string; requestId?: string; roles: string[] };

const HOOK_KEY = "warehouse_hook_key";

// ===== Webhook Apps Script (file kho) =====

const digest = (s: string) => createHash("sha256").update(s).digest();
// So sánh hằng thời gian (băm trước để 2 buffer luôn cùng độ dài).
export function hookKeyMatches(candidate: string, expected: string): boolean {
  if (!candidate || !expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

export type SyncHookBody = { dayLock?: unknown; tab?: unknown; code?: unknown; row?: unknown; bill?: unknown; thung?: unknown };

// Key nhận từ header X-Warehouse-Webhook-Key (mới), hoặc ?key= / X-Hook-Key (Apps Script đang dùng) - chấp nhận cả hai.
// Kết quả trả về phụ thuộc kết quả khớp sheet -> chạy đồng bộ (không đưa vào queue).
export async function handleSyncHook(candidateKeys: string[], body: SyncHookBody | undefined) {
  const expected = (await prisma.appConfig.findUnique({ where: { key: HOOK_KEY } }))?.value;
  if (!expected || !candidateKeys.some((k) => hookKeyMatches(k, expected))) throw new LegacyError(401, "BAD_KEY");
  // Kho tick Z1 (checkbox "Đã nộp hải quan") của tab -> khóa/mở khóa ngày đó ngay, không cần vào app bấm "Chốt ngày".
  if (typeof body?.dayLock === "boolean" && body?.tab) {
    await setDayLockFromTab(String(body.tab), body.dayLock);
    return { ok: true };
  }
  // TỨC THÌ: webhook gửi mã + ô vừa gõ -> khớp đúng 1 dòng. Không có mã -> quét tab gần đây (fallback).
  if (body?.code) {
    return syncPackedOne(
      String(body.code),
      body.tab ? String(body.tab) : undefined,
      body.row ? Number(body.row) : undefined,
      body.bill ? String(body.bill) : undefined,
      body.thung ? String(body.thung) : undefined,
    );
  }
  return syncPackedFromWarehouse({ recentDays: 45 });
}

async function getHookKey(): Promise<string> {
  const existing = await prisma.appConfig.findUnique({ where: { key: HOOK_KEY } });
  if (existing?.value) return existing.value;
  const k = (uuid() + uuid()).replace(/-/g, "");
  await prisma.appConfig.upsert({ where: { key: HOOK_KEY }, update: { value: k }, create: { key: HOOK_KEY, value: k } });
  return k;
}

// Link file kho (bên đóng hàng quét tracking) — lưu trong AppConfig. hookUrl giữ dạng ?key= (Apps Script đang dán link này).
export async function getPackConfig(baseUrl: string) {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const hookKey = await getHookKey();
  const hookUrl = `${baseUrl}/api/warehouse/sync-hook?key=${hookKey}`;
  return { sheetUrl: cfg?.value ?? "", sheetId: cfg?.value ? parseSheetId(cfg.value) : null, hookUrl };
}

export async function setPackConfig(sheetUrl: string | null | undefined, actor: Actor) {
  const url = (sheetUrl ?? "").trim();
  if (url && !parseSheetId(url)) throw new LegacyError(400, "BAD_URL", "Link Google Sheet không hợp lệ");
  await prisma.appConfig.upsert({ where: { key: "warehouse_sheet_id" }, update: { value: url }, create: { key: "warehouse_sheet_id", value: url } });
  await logAudit({ actorId: actor.id, action: "warehouse.pack_config_set", requestId: actor.requestId });
  return { sheetUrl: url, sheetId: url ? parseSheetId(url) : null };
}

// Quét file kho ngay: mã trùng -> đóng hàng về (cam). Trả số đếm -> đồng bộ.
export async function syncPackNow(actor: Actor) {
  const r = await syncPackedFromWarehouse();
  await logAudit({ actorId: actor.id, action: "warehouse.sync_pack", metadata: r, requestId: actor.requestId });
  return r;
}

// ===== Bảng kho VN: tracking đóng từ Nhật, chia theo NGÀY > KIỆN > tracking =====

export const dayKey = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
export const effKg = (t: { jpWeightKg: unknown; vnWeightKg: unknown }) =>
  t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);

const NO_DAY = "0000-00-00";

export function buildVnBoard([cartons, loose]: repo.BoardData) {
  type Day = { day: string; cartons: any[]; unassigned: any[] };
  const days = new Map<string, Day>();
  const getDay = (k: string) => { let d = days.get(k); if (!d) { d = { day: k, cartons: [], unassigned: [] }; days.set(k, d); } return d; };

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

  // Kiện đã dồn hết tracking sang Lưu kho (0 dòng còn hiện trên board, nhưng TỪNG có tracking) không còn gì để
  // đối soát ở đây nữa - ẩn khỏi board cho đỡ rác. Kiện mới tạo, chưa từng gán mã nào thì vẫn giữ để còn gán tiếp.
  for (const d of days.values()) d.cartons = d.cartons.filter((c) => c.count > 0 || c.everAssignedCount === 0);
  return [...days.values()].filter((d) => d.cartons.length > 0 || d.unassigned.length > 0).sort((a, b) => (a.day < b.day ? 1 : -1));
}

export async function getVnBoard(customer?: string) {
  return buildVnBoard(await repo.findBoardData(customer));
}

export const listStored = (customer?: string) => repo.findStored(customer);
export const searchHistory = (q: { date?: string; vnTrackingCode?: string; code?: string }) => repo.findHistory(q);

// ===== Cân VN + Tracking VN =====

// Cân VN + Tracking VN (nội địa) — việc của Kho VN, tách khỏi quyền sửa tracking (trackings.update, dành cho sale/buyer)
// để đúng ý: kho chỉ cân + gán tracking nội địa, không tự thêm/sửa mã tracking Nhật hay gán đơn.
export async function weighVn(id: string, input: { vnWeightKg?: number; vnTrackingCode?: string; jpWeightKg?: number }, actor: Actor) {
  const before = await prisma.tracking.findUnique({
    where: { id },
    select: { vnTrackingCode: true, cartonId: true, carton: { select: { declaredWeightKg: true, vnTotalWeightKg: true, weightConfirmedAt: true } } },
  });
  if (!before) throw new LegacyError(404, "NOT_FOUND");
  // Cân JP (kho Nhật) là việc của Sale/NV mua (trackings.update), Kho VN chỉ cân/gán tracking VN - không được sửa cân Nhật.
  if (input.jpWeightKg !== undefined && !actor.roles.includes("super_admin")) {
    const perms = await loadPermissions(actor.id);
    if (!perms.includes("trackings.update")) throw new LegacyError(403, "FORBIDDEN", "Thiếu quyền: trackings.update");
  }
  // Kiện đang khóa (thiếu tổng cân hoặc lệch >=1kg chưa xác nhận) - chặn điền cân VN từng mã lẻ, vẫn cho điền Tracking VN.
  if (input.vnWeightKg !== undefined && before.carton && cartonWeightLocked(before.carton)) {
    throw new LegacyError(423, "CARTON_LOCKED", "Kiện đang khóa cân - đối soát tổng cân Nhật/VN (hoặc xác nhận lệch) trước");
  }
  const data: typeof input & { deliveredAt?: Date | null } = { ...input };
  // Điền Tracking VN lần đầu -> ghi nhận đúng ngày này là "Ngày giao cho khách hàng" trên sheet khách.
  // Xóa trắng lại thì tự bỏ ngày đi (không giữ ngày cũ), không phải ngày lúc sync/quét lại.
  if (input.vnTrackingCode !== undefined) {
    const hadBefore = !!before.vnTrackingCode;
    const hasNow = !!input.vnTrackingCode;
    if (hasNow && !hadBefore) data.deliveredAt = new Date();
    else if (!hasNow) data.deliveredAt = null;
  }
  const t = await prisma.$transaction(async (tx) => {
    const t = await tx.tracking.update({ where: { id }, data });
    if (t.orderId) {
      await recomputeOrderTotals(t.orderId, tx);
      // Tracking VN lần đầu -> đơn tự tiến tới "delivered" (order.state: chỉ tiến, không đụng đơn chốt tay).
      if (data.deliveredAt) await bumpOrderStatus(t.orderId, "delivered", tx);
    }
    return t;
  });
  if (t.orderId) await queueOrderCustomerSync(t.orderId);
  void queueTrackingSheetRow(t.id);
  eventBus.publish({ eventName: "tracking.updated", actorId: actor.id, entityType: "tracking", entityId: t.id, metadata: { fields: Object.keys(input) } });
  return t;
}

// "Chuyển lưu kho": hàng chưa ship xong nhưng cần dọn khỏi board chính để làm ngày mới, vẫn xem/lọc lại được ở /warehouse/stored
export async function storeTrackings(ids: string[], actor: Actor) {
  // storedAt chỉ set lần đầu (không đè lại nếu đã có) - đúng mốc "bắt đầu nằm lưu kho" để tính tuổi tồn kho,
  // tránh bị reset về "mới" nếu lỡ bấm "Chuyển lưu kho" lại cho hàng đã lưu kho từ trước.
  const stored = await prisma.$transaction(async (tx) => {
    await tx.tracking.updateMany({ where: { id: { in: ids }, storedAt: null }, data: { status: "stored", storedAt: new Date() } });
    await tx.tracking.updateMany({ where: { id: { in: ids }, storedAt: { not: null } }, data: { status: "stored" } });
    const stored = await tx.tracking.findMany({ where: { id: { in: ids } }, select: { orderId: true, order: { select: { customerId: true } } } });
    // Hàng vào lưu kho VN -> đơn tự tiến tới "vn_warehouse" (order.state).
    await bumpOrderStatus([...new Set(stored.map((s) => s.orderId).filter((c): c is string => !!c))], "vn_warehouse", tx);
    return stored;
  });
  await logAudit({ actorId: actor.id, action: "warehouse.store", metadata: { count: ids.length }, requestId: actor.requestId });
  // Đổ chữ/màu "lưu kho" ngay lên sheet khách, không đợi lần sync khác.
  const customerIds = new Set(stored.map((s) => s.order?.customerId).filter((c): c is string => !!c));
  for (const cid of customerIds) void queueCustomerSheetSync(cid);
  for (const id of ids) eventBus.publish({ eventName: "tracking.updated", actorId: actor.id, entityType: "tracking", entityId: id, metadata: { status: "stored" } });
  return { stored: ids.length };
}

// Thêm tracking tay vào kiện (khi seller/kho quét sai mã, đơn không tự khớp).
export async function addManualTracking(input: { orderCode: string; code: string; jpWeightKg?: number; cartonId?: string }, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { code: input.orderCode.trim() }, select: { id: true, customerId: true } });
  if (!order) throw new LegacyError(404, "ORDER_NOT_FOUND");
  const code = input.code.trim();
  // Đơn đã có sẵn tracking đúng mã này (vd gõ lại mã đã nhập ở ô "Điền mã" trang đơn) -> cập nhật, không tạo bản ghi trùng
  // (trước đây tạo thẳng bản ghi mới, khiến 1 đơn có 2 tracking cùng mã, hiện lặp "mã +mã" ngoài danh sách đơn).
  const t = await prisma.$transaction(async (tx) => {
    const existing = await tx.tracking.findFirst({ where: { orderId: order.id, code } });
    const t = existing
      ? await tx.tracking.update({
          where: { id: existing.id },
          data: { jpWeightKg: input.jpWeightKg, cartonId: input.cartonId, cartonManual: !!input.cartonId, packedAt: existing.packedAt ?? new Date(), status: "linked" },
        })
      // Mã có thể đã bị kho quét trước đó (mồ côi ở đơn khác/chưa gắn đơn) -> claim lại thay vì tạo trùng
      : await claimOrCreateTracking(order.id, code, {
          jpWeightKg: input.jpWeightKg, cartonId: input.cartonId, cartonManual: !!input.cartonId, packedAt: new Date(),
        }, tx);
    await recomputeOrderTotals(order.id, tx);
    return t;
  });
  void queueCustomerSheetSync(order.customerId);
  void queueTrackingSheetRow(t.id);
  await logAudit({ actorId: actor.id, targetId: t.id, action: "warehouse.tracking_added_manual", metadata: { orderCode: input.orderCode, code: input.code }, requestId: actor.requestId });
  eventBus.publish({ eventName: "tracking.assigned", actorId: actor.id, entityType: "tracking", entityId: t.id, metadata: { orderId: order.id } });
  return t;
}

// Gỡ tracking khỏi Kho VN: nếu mồ côi (không thuộc đơn nào) thì xóa hẳn - an toàn vì không có gì để mất.
// Nếu thuộc đơn thật thì KHÔNG xóa (dữ liệu đơn/kế toán phải giữ nguyên) - chỉ reset trạng thái đóng gói
// để biến mất khỏi board, quét sheet lại vẫn tự nhảy vào bình thường.
export async function removeFromVnWarehouse(id: string, actor: Actor) {
  const t = await prisma.tracking.findUnique({ where: { id } });
  if (!t) throw new LegacyError(404, "NOT_FOUND");
  if (!t.orderId) await assertTrackingDeletable(t.id);
  // Gỡ qua APP (không phải kho tự xóa mã trong sheet) - cron quét file kho sẽ không còn cơ hội tự dọn màu/nội
  // dung dòng vật lý từng chiếm nữa (nhất là sau khi packedAt/packRow reset), nên phải tự dọn ngay ở đây.
  void queueWarehouseRowClear(t.packedAt, t.packRow);
  if (!t.orderId) {
    await prisma.$transaction(async (tx) => {
      await tx.trackingLog.deleteMany({ where: { trackingId: t.id } });
      await tx.tracking.delete({ where: { id: t.id } });
    });
    await logAudit({ actorId: actor.id, targetId: t.id, action: "tracking.deleted", metadata: { code: t.code }, requestId: actor.requestId });
  } else {
    const orderId = t.orderId;
    await prisma.$transaction(async (tx) => {
      await tx.tracking.update({
        where: { id: t.id },
        data: { packedAt: null, packRow: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, deliveredAt: null },
      });
      await recomputeOrderTotals(orderId, tx);
    });
    await logAudit({ actorId: actor.id, targetId: t.id, action: "warehouse.tracking_unpacked", metadata: { code: t.code }, requestId: actor.requestId });
    // Gỡ khỏi Kho VN thì sheet khách cũng phải tự mất theo (cân/lưu kho/tracking VN/ngày giao) - không đợi sync khác.
    await queueOrderCustomerSync(t.orderId);
    eventBus.publish({ eventName: "tracking.updated", actorId: actor.id, entityType: "tracking", entityId: t.id, metadata: { unpacked: true } });
  }
  await deleteCartonIfEmpty(t.cartonId);
}

// ===== Chốt ngày khai hải quan =====
// Mã tracking quét vào SAU khi ngày đã chốt sẽ bị đánh dấu lateAfterLock, không gộp vào invoice ngày đó nữa
// (xem modules/sheets syncPackedOne/syncPackedFromWarehouse).

export const listDayLocks = () => prisma.packDayLock.findMany({ orderBy: { date: "desc" }, take: 60 });

export async function lockDay(date: string, actor: Actor) {
  const d = new Date(`${date}T00:00:00`);
  const row = await prisma.packDayLock.upsert({ where: { date: d }, update: {}, create: { date: d, lockedBy: actor.id } });
  await logAudit({ actorId: actor.id, action: "warehouse.day_lock", metadata: { date }, requestId: actor.requestId });
  return row;
}

export async function unlockDay(date: string, actor: Actor) {
  const d = new Date(`${date}T00:00:00`);
  await prisma.packDayLock.deleteMany({ where: { date: d } });
  await logAudit({ actorId: actor.id, action: "warehouse.day_unlock", metadata: { date }, requestId: actor.requestId });
}

export const listLateAfterLock = () => repo.findLateAfterLock();

export async function resolveLateAfterLock(id: string) {
  await prisma.tracking.update({ where: { id }, data: { lateAfterLock: false } });
}

// ===== Endpoint cũ (Kho VN nhập mã VN / Cân Nhật / Đối soát cân theo đơn) =====

export async function setVnTrackingCode(trackingId: string, vnTrackingCode: string, actor: Actor) {
  const t = await prisma.tracking.update({ where: { id: trackingId }, data: { vnTrackingCode } });
  void queueTrackingSheetRow(t.id);
  await logAudit({ actorId: actor.id, targetId: t.id, action: "warehouse.vn_tracking_set", requestId: actor.requestId });
  eventBus.publish({ eventName: "tracking.updated", actorId: actor.id, entityType: "tracking", entityId: t.id, metadata: { vnTrackingCode } });
  return t;
}

export async function setJpWeight(trackingId: string, jpWeightKg: number, actor: Actor) {
  const t = await prisma.tracking.update({ where: { id: trackingId }, data: { jpWeightKg } });
  await logAudit({ actorId: actor.id, targetId: t.id, action: "warehouse.jp_weighed", requestId: actor.requestId });
  return t;
}

// Cân VN + đối soát chênh cân (so với tổng cân Nhật của đơn)
export async function reconcileOrderWeight(input: { orderId: string; vnWeight: number; note?: string }, actor: Actor) {
  const trackings = await prisma.tracking.findMany({ where: { orderId: input.orderId } });
  const jpWeight = trackings.reduce((s, t) => s + Number(t.jpWeightKg ?? 0), 0);
  const diff = Number((input.vnWeight - jpWeight).toFixed(3));
  const recon = await prisma.weightRecon.create({
    data: { id: uuid(), orderId: input.orderId, jpWeight, vnWeight: input.vnWeight, diffKg: diff, note: input.note },
  });
  await logAudit({ actorId: actor.id, targetId: input.orderId, action: "warehouse.vn_weighed", metadata: { jpWeight, vnWeight: input.vnWeight, diff }, requestId: actor.requestId });
  return recon;
}

export const listRecon = () => prisma.weightRecon.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
