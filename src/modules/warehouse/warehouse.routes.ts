import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { syncTracking, syncPackedFromWarehouse, syncPackedOne, parseSheetId } from "../../utils/gsheets.js";

export const warehouseRouter = Router();

// Webhook cho Apps Script (KHÔNG qua JWT) — xác thực bằng key bí mật. Đặt TRƯỚC authenticate.
warehouseRouter.post("/sync-hook", async (req, res) => {
  const key = String(req.query.key ?? req.headers["x-hook-key"] ?? "");
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_hook_key" } });
  if (!cfg?.value || key !== cfg.value) return res.status(401).json({ error: "BAD_KEY" });
  // TỨC THÌ: webhook gửi mã + ô vừa gõ -> khớp đúng 1 dòng. Không có mã -> quét tab gần đây (fallback).
  const code = req.body?.code;
  if (code) {
    const r = await syncPackedOne(String(code), req.body?.tab ? String(req.body.tab) : undefined, req.body?.row ? Number(req.body.row) : undefined);
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

warehouseRouter.get("/vn-board", authorize("trackings.list"), async (_req, res) => {
  const trkSelect = {
    id: true, code: true, cartonId: true, jpWeightKg: true, vnWeightKg: true, vnTrackingCode: true, packedAt: true,
    order: { select: { code: true, customer: { select: { name: true } } } },
  } as const;
  const [cartons, loose] = await Promise.all([
    prisma.carton.findMany({ orderBy: { createdAt: "desc" }, include: { trackings: { select: trkSelect } } }),
    prisma.tracking.findMany({ where: { packedAt: { not: null }, cartonId: null }, select: trkSelect, orderBy: { packedAt: "desc" } }),
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
