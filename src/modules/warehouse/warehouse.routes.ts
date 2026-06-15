import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const warehouseRouter = Router();
warehouseRouter.use(authenticate);

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
