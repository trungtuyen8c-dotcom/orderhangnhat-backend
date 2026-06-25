import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { syncTracking, syncPackedFromWarehouse, parseSheetId } from "../../utils/gsheets.js";

export const warehouseRouter = Router();

// Webhook cho Apps Script (KHÔNG qua JWT) — xác thực bằng key bí mật. Đặt TRƯỚC authenticate.
warehouseRouter.post("/sync-hook", async (req, res) => {
  const key = String(req.query.key ?? req.headers["x-hook-key"] ?? "");
  const cfg = await prisma.appConfig.findUnique({ where: { key: "warehouse_hook_key" } });
  if (!cfg?.value || key !== cfg.value) return res.status(401).json({ error: "BAD_KEY" });
  const r = await syncPackedFromWarehouse();
  res.json(r);
});

warehouseRouter.use(authenticate);

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
