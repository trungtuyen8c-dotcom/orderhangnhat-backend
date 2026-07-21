import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { syncTracking, syncPackedFromWarehouse, syncPackedOne, parseSheetId, syncCustomerOrders, setDayLockFromTab, clearWarehouseRow } from "../../utils/gsheets.js";
import { recomputeOrderTotals } from "../../utils/orderTotals.js";
import { deleteCartonIfEmpty } from "../../utils/cartons.js";
import { claimOrCreateTracking } from "../../utils/trackingClaim.js";

export const warehouseRouter = Router();

// Webhook cho Apps Script (KHÔNG qua JWT) — xác thực bằng key bí mật. Đặt TRƯỚC authenticate.
warehouseRouter.post("/sync-hook", async (req, res) => {
  const key = String(req.query.key ?? req.headers["x-hook-key"] ?? "");
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_hook_key" } });
  if (!cfg?.value || key !== cfg.value) return res.status(401).json({ error: "BAD_KEY" });
  // Kho tick Z1 (checkbox "Đã nộp hải quan") của tab -> khóa/mở khóa ngày đó ngay, không cần vào app bấm "Chốt ngày".
  if (typeof req.body?.dayLock === "boolean" && req.body?.tab) {
    await setDayLockFromTab(String(req.body.tab), req.body.dayLock);
    return res.json({ ok: true });
  }
  // TỨC THÌ: webhook gửi mã + ô vừa gõ -> khớp đúng 1 dòng. Không có mã -> quét tab gần đây (fallback).
  const code = req.body?.code;
  if (code) {
    const r = await syncPackedOne(
      String(code),
      req.body?.tab ? String(req.body.tab) : undefined,
      req.body?.row ? Number(req.body.row) : undefined,
      req.body?.bill ? String(req.body.bill) : undefined,
      req.body?.thung ? String(req.body.thung) : undefined,
    );
    return res.json(r);
  }
  const r = await syncPackedFromWarehouse({ recentDays: 45 });
  res.json(r);
});

warehouseRouter.use(authenticate);

// ===== Bảng kho VN: tracking đóng từ Nhật, chia theo NGÀY > KIỆN > tracking =====
const dayKey = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
const effKg = (t: { jpWeightKg: unknown; vnWeightKg: unknown }) =>
  t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);

warehouseRouter.get("/vn-board", authorize("trackings.list"), async (req, res) => {
  const trkSelect = {
    id: true, code: true, cartonId: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true, customsName: true,
    order: { select: { code: true, customer: { select: { name: true } } } },
  } as const;
  // Đã "Chuyển lưu kho" thì ra khỏi board chính (xem ở /warehouse/stored), trừ khi đã ship (có Tracking VN) thì luôn loại khỏi board.
  // Đơn chỉ order hộ - hàng về kho khác (externalWarehouse) không qua kho VN của mình -> loại luôn khỏi board.
  // Đơn chỉ lấy chứng từ, giao thẳng công ty (skipVnWeighing) - vẫn qua kho nhưng không cần cân -> loại khỏi board.
  const boardWhere = { status: { not: "stored" }, OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], NOT: { order: { OR: [{ externalWarehouse: true }, { skipVnWeighing: true }] } } };
  const customerQ = String(req.query.customer ?? "").trim();
  const customerFilter = customerQ ? { order: { customer: { name: { contains: customerQ, mode: "insensitive" as const } } } } : {};
  const [cartons, loose] = await Promise.all([
    prisma.carton.findMany({ orderBy: { createdAt: "desc" }, include: { trackings: { where: { ...boardWhere, ...customerFilter }, select: trkSelect, orderBy: [{ packedAt: "asc" }, { packRow: "asc" }] } } }),
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
    const actualKg = Number(c.trackings.reduce((s, t) => s + effKg(t), 0).toFixed(3));
    getDay(k).cartons.push({
      id: c.id, code: c.code, note: c.note, declaredWeightKg: declared,
      actualKg, count: c.trackings.length, diffKg: declared != null ? Number((actualKg - declared).toFixed(3)) : null,
      trackings: c.trackings,
    });
  }
  for (const t of loose) getDay(dayKey(t.packedAt)!).unassigned.push(t);

  const out = [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1));
  res.json(out);
});

// Cân VN + Tracking VN (nội địa) — việc của Kho VN, tách khỏi quyền sửa tracking (trackings.update, dành cho sale/buyer)
// để đúng ý: kho chỉ cân + gán tracking nội địa, không tự thêm/sửa mã tracking Nhật hay gán đơn.
const vnWeighSchema = z.object({ vnWeightKg: z.number().nonnegative().optional(), vnTrackingCode: z.string().optional(), jpWeightKg: z.number().nonnegative().optional() });
warehouseRouter.patch("/tracking/:id/vn", authorize("warehouse.weigh_vn"), async (req, res) => {
  const p = vnWeighSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const data: typeof p.data & { deliveredAt?: Date | null } = { ...p.data };
  // Điền Tracking VN lần đầu -> ghi nhận đúng ngày này là "Ngày giao cho khách hàng" trên sheet khách.
  // Xóa trắng lại thì tự bỏ ngày đi (không giữ ngày cũ), không phải ngày lúc sync/quét lại.
  if (p.data.vnTrackingCode !== undefined) {
    const before = await prisma.tracking.findUnique({ where: { id: req.params.id }, select: { vnTrackingCode: true } });
    const hadBefore = !!before?.vnTrackingCode;
    const hasNow = !!p.data.vnTrackingCode;
    if (hasNow && !hadBefore) data.deliveredAt = new Date();
    else if (!hasNow) data.deliveredAt = null;
  }
  const t = await prisma.tracking.update({ where: { id: req.params.id }, data });
  if (t.orderId) { await recomputeOrderTotals(t.orderId); const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } }); if (o) void syncCustomerOrders(o.customerId); }
  void syncTracking(t);
  res.json(t);
});

// "Chuyển lưu kho": hàng chưa ship xong nhưng cần dọn khỏi board chính để làm ngày mới, vẫn xem/lọc lại được ở /warehouse/stored
const storeSchema = z.object({ ids: z.array(z.string().uuid()).min(1) });
warehouseRouter.post("/store", authorize("warehouse.weigh_vn"), async (req, res) => {
  const p = storeSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const r = await prisma.tracking.updateMany({ where: { id: { in: p.data.ids } }, data: { status: "stored" } });
  await logAudit({ actorId: req.user!.id, action: "warehouse.store", metadata: { count: r.count } });
  // Đổ chữ/màu "lưu kho" ngay lên sheet khách, không đợi lần sync khác.
  const stored = await prisma.tracking.findMany({ where: { id: { in: p.data.ids } }, select: { order: { select: { customerId: true } } } });
  const customerIds = new Set(stored.map((s) => s.order?.customerId).filter((c): c is string => !!c));
  for (const cid of customerIds) void syncCustomerOrders(cid);
  res.json({ stored: r.count });
});

warehouseRouter.get("/stored", authorize("warehouse.weigh_vn"), async (req, res) => {
  const customerQ = String(req.query.customer ?? "").trim();
  const customerFilter = customerQ ? { order: { customer: { name: { contains: customerQ, mode: "insensitive" as const } } } } : {};
  const rows = await prisma.tracking.findMany({
    where: { status: "stored", OR: [{ vnTrackingCode: null }, { vnTrackingCode: "" }], ...customerFilter },
    orderBy: { packedAt: "asc" }, take: 500,
    select: {
      id: true, code: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true,
      carton: { select: { code: true } }, order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
  res.json(rows);
});

// Thêm tracking tay vào kiện (khi seller/kho quét sai mã, đơn không tự khớp) — chỉ sale/buyer/admin (trackings.create),
// Kho VN KHÔNG có quyền này vì là việc nội bộ gán đơn, không phải cân/ship.
const addManualSchema = z.object({ orderCode: z.string().min(1), code: z.string().min(1), jpWeightKg: z.number().nonnegative().optional(), cartonId: z.string().uuid().optional() });
warehouseRouter.post("/tracking", authorize("trackings.create"), async (req, res) => {
  const p = addManualSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const order = await prisma.order.findUnique({ where: { code: p.data.orderCode.trim() }, select: { id: true, customerId: true } });
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const code = p.data.code.trim();
  // Đơn đã có sẵn tracking đúng mã này (vd gõ lại mã đã nhập ở ô "Điền mã" trang đơn) -> cập nhật, không tạo bản ghi trùng
  // (trước đây tạo thẳng bản ghi mới, khiến 1 đơn có 2 tracking cùng mã, hiện lặp "mã +mã" ngoài danh sách đơn).
  const existing = await prisma.tracking.findFirst({ where: { orderId: order.id, code } });
  const t = existing
    ? await prisma.tracking.update({
        where: { id: existing.id },
        data: { jpWeightKg: p.data.jpWeightKg, cartonId: p.data.cartonId, cartonManual: !!p.data.cartonId, packedAt: existing.packedAt ?? new Date(), status: "linked" },
      })
    // Mã có thể đã bị kho quét trước đó (mồ côi ở đơn khác/chưa gắn đơn) -> claim lại thay vì tạo trùng
    : await claimOrCreateTracking(order.id, code, {
        jpWeightKg: p.data.jpWeightKg, cartonId: p.data.cartonId, cartonManual: !!p.data.cartonId, packedAt: new Date(),
      });
  await recomputeOrderTotals(order.id);
  void syncCustomerOrders(order.customerId);
  void syncTracking(t);
  await logAudit({ actorId: req.user!.id, targetId: t.id, action: "warehouse.tracking_added_manual", metadata: { orderCode: p.data.orderCode, code: p.data.code } });
  res.status(201).json(t);
});

// Gỡ tracking khỏi Kho VN: nếu mồ côi (không thuộc đơn nào) thì xóa hẳn - an toàn vì không có gì để mất.
// Nếu thuộc đơn thật thì KHÔNG xóa (dữ liệu đơn/kế toán phải giữ nguyên) - chỉ reset trạng thái đóng gói
// để biến mất khỏi board, quét sheet lại vẫn tự nhảy vào bình thường.
warehouseRouter.delete("/tracking/:id", authorize("trackings.delete"), async (req, res) => {
  const t = await prisma.tracking.findUnique({ where: { id: req.params.id } });
  if (!t) return res.status(404).json({ error: "NOT_FOUND" });
  // Gỡ qua APP (không phải kho tự xóa mã trong sheet) - cron quét file kho sẽ không còn cơ hội tự dọn màu/nội
  // dung dòng vật lý từng chiếm nữa (nhất là sau khi packedAt/packRow reset), nên phải tự dọn ngay ở đây.
  void clearWarehouseRow(t.packedAt, t.packRow);
  if (!t.orderId) {
    await prisma.trackingLog.deleteMany({ where: { trackingId: t.id } });
    await prisma.tracking.delete({ where: { id: t.id } });
    await logAudit({ actorId: req.user!.id, targetId: t.id, action: "tracking.deleted", metadata: { code: t.code } });
  } else {
    await prisma.tracking.update({
      where: { id: t.id },
      data: { packedAt: null, packRow: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, deliveredAt: null },
    });
    await logAudit({ actorId: req.user!.id, targetId: t.id, action: "warehouse.tracking_unpacked", metadata: { code: t.code } });
    // Gỡ khỏi Kho VN thì sheet khách cũng phải tự mất theo (cân/lưu kho/tracking VN/ngày giao) - không đợi sync khác.
    await recomputeOrderTotals(t.orderId);
    const o = await prisma.order.findUnique({ where: { id: t.orderId }, select: { customerId: true } });
    if (o) void syncCustomerOrders(o.customerId);
  }
  await deleteCartonIfEmpty(t.cartonId);
  res.json({ ok: true });
});

async function getHookKey(): Promise<string> {
  const existing = await prisma.appConfig.findUnique({ where: { key: "warehouse_hook_key" } });
  if (existing?.value) return existing.value;
  const k = (uuid() + uuid()).replace(/-/g, "");
  await prisma.appConfig.upsert({ where: { key: "warehouse_hook_key" }, update: { value: k }, create: { key: "warehouse_hook_key", value: k } });
  return k;
}

// Link file kho (bên đóng hàng quét tracking) — lưu trong AppConfig
warehouseRouter.get("/pack-config", authorize("system.manage_settings"), async (req, res) => {
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_sheet_id" } });
  const hookKey = await getHookKey();
  const hookUrl = `${req.protocol}://${req.get("host")}/api/warehouse/sync-hook?key=${hookKey}`;
  res.json({ sheetUrl: cfg?.value ?? "", sheetId: cfg?.value ? parseSheetId(cfg.value) : null, hookUrl });
});

const packCfgSchema = z.object({ sheetUrl: z.string().nullable().optional() });
warehouseRouter.put("/pack-config", authorize("system.manage_settings"), async (req, res) => {
  const p = packCfgSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const url = (p.data.sheetUrl ?? "").trim();
  if (url && !parseSheetId(url)) return res.status(400).json({ error: "BAD_URL", message: "Link Google Sheet không hợp lệ" });
  await prisma.appConfig.upsert({ where: { key: "warehouse_sheet_id" }, update: { value: url }, create: { key: "warehouse_sheet_id", value: url } });
  await logAudit({ actorId: req.user!.id, action: "warehouse.pack_config_set" });
  res.json({ sheetUrl: url, sheetId: url ? parseSheetId(url) : null });
});

// Quét file kho ngay: mã trùng -> đóng hàng về (cam)
warehouseRouter.post("/sync-pack", authorize("system.manage_settings"), async (req, res) => {
  const r = await syncPackedFromWarehouse();
  await logAudit({ actorId: req.user!.id, action: "warehouse.sync_pack", metadata: r });
  res.json(r);
});

// "Chốt ngày" khai hải quan: mã tracking quét vào SAU khi ngày đã chốt sẽ bị đánh dấu lateAfterLock,
// không gộp vào invoice ngày đó nữa (xem gsheets.ts syncPackedOne/syncPackedFromWarehouse).
// Đọc (không sửa) - mở cho shipments.list dùng để lọc "Cần lấy thuế" theo ngày chuyến/chốt hải quan.
warehouseRouter.get("/day-locks", authorize("shipments.list"), async (_req, res) => {
  const rows = await prisma.packDayLock.findMany({ orderBy: { date: "desc" }, take: 60 });
  res.json(rows);
});
const dayLockSchema = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
warehouseRouter.post("/day-locks", authorize("system.manage_settings"), async (req, res) => {
  const p = dayLockSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const date = new Date(`${p.data.date}T00:00:00`);
  const row = await prisma.packDayLock.upsert({ where: { date }, update: {}, create: { date, lockedBy: req.user!.id } });
  await logAudit({ actorId: req.user!.id, action: "warehouse.day_lock", metadata: { date: p.data.date } });
  res.status(201).json(row);
});
warehouseRouter.delete("/day-locks/:date", authorize("system.manage_settings"), async (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return res.status(400).json({ error: "BAD_REQUEST" });
  const date = new Date(`${req.params.date}T00:00:00`);
  await prisma.packDayLock.deleteMany({ where: { date } });
  await logAudit({ actorId: req.user!.id, action: "warehouse.day_unlock", metadata: { date: req.params.date } });
  res.json({ ok: true });
});

// Danh sách tracking quét sau khi ngày đã chốt - cần khai bổ sung hải quan riêng
warehouseRouter.get("/late-after-lock", authorize("system.manage_settings"), async (_req, res) => {
  const rows = await prisma.tracking.findMany({
    where: { lateAfterLock: true },
    orderBy: { packedAt: "desc" }, take: 200,
    select: { id: true, code: true, packedAt: true, order: { select: { code: true, customer: { select: { name: true } } } } },
  });
  res.json(rows);
});
warehouseRouter.post("/late-after-lock/:id/resolve", authorize("system.manage_settings"), async (req, res) => {
  await prisma.tracking.update({ where: { id: req.params.id }, data: { lateAfterLock: false } });
  res.json({ ok: true });
});

// Kho VN: nhập mã tracking nội địa VN cho 1 tracking
const vnTrackSchema = z.object({ trackingId: z.string().uuid(), vnTrackingCode: z.string().min(1) });
warehouseRouter.post("/vn-tracking", authorize("warehouse.weigh_vn"), async (req, res) => {
  const p = vnTrackSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.update({ where: { id: p.data.trackingId }, data: { vnTrackingCode: p.data.vnTrackingCode } });
  void syncTracking(t);
  await logAudit({ actorId: req.user!.id, targetId: t.id, action: "warehouse.vn_tracking_set" });
  res.json(t);
});

// Cân Nhật: cập nhật cân cho tracking
const jpSchema = z.object({ trackingId: z.string().uuid(), jpWeightKg: z.number().nonnegative() });
warehouseRouter.post("/jp-weight", authorize("warehouse.weigh_jp"), async (req, res) => {
  const p = jpSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const t = await prisma.tracking.update({ where: { id: p.data.trackingId }, data: { jpWeightKg: p.data.jpWeightKg } });
  await logAudit({ actorId: req.user!.id, targetId: t.id, action: "warehouse.jp_weighed" });
  res.json(t);
});

// Cân VN + đối soát chênh cân (so với tổng cân Nhật của đơn)
const vnSchema = z.object({ orderId: z.string().uuid(), vnWeight: z.number().nonnegative(), note: z.string().optional() });
warehouseRouter.post("/vn-weight", authorize("warehouse.weigh_vn"), async (req, res) => {
  const p = vnSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const trackings = await prisma.tracking.findMany({ where: { orderId: p.data.orderId } });
  const jpWeight = trackings.reduce((s, t) => s + Number(t.jpWeightKg ?? 0), 0);
  const diff = Number((p.data.vnWeight - jpWeight).toFixed(3));
  const recon = await prisma.weightRecon.create({
    data: { id: uuid(), orderId: p.data.orderId, jpWeight, vnWeight: p.data.vnWeight, diffKg: diff, note: p.data.note },
  });
  await logAudit({ actorId: req.user!.id, targetId: p.data.orderId, action: "warehouse.vn_weighed", metadata: { jpWeight, vnWeight: p.data.vnWeight, diff } });
  res.status(201).json(recon);
});

warehouseRouter.get("/recon", authorize("warehouse.weigh_vn"), async (_req, res) => {
  const rows = await prisma.weightRecon.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  res.json(rows);
});
