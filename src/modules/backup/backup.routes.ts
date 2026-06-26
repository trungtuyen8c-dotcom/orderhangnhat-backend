import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { rcloneConnected, setRcloneToken, disconnectRclone, runBackup } from "../../utils/backup.js";

export const backupRouter = Router();
backupRouter.use(authenticate);

const serialize = (r: any) => ({ ...r, sizeBytes: Number(r.sizeBytes ?? 0) });

backupRouter.get("/status", authorize("system.manage_settings"), async (_req, res) => {
  const connected = await rcloneConnected();
  const last = await prisma.backupRun.findFirst({ orderBy: { startedAt: "desc" } });
  const running = await prisma.backupRun.count({ where: { status: { in: ["pending", "running"] } } });
  res.json({ connected, running: running > 0, last: last ? serialize(last) : null });
});

backupRouter.get("/runs", authorize("system.manage_settings"), async (_req, res) => {
  const runs = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, take: 30 });
  res.json(runs.map(serialize));
});

const tokenSchema = z.object({ token: z.string().min(10) });
backupRouter.put("/rclone-token", authorize("system.manage_settings"), async (req, res) => {
  const p = tokenSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  try {
    await setRcloneToken(p.data.token.trim());
    await logAudit({ actorId: req.user!.id, action: "backup.connect_drive" });
    res.json({ connected: await rcloneConnected() });
  } catch {
    res.status(400).json({ error: "BAD_TOKEN", message: "Token không hợp lệ" });
  }
});

backupRouter.post("/disconnect", authorize("system.manage_settings"), async (req, res) => {
  await disconnectRclone();
  await logAudit({ actorId: req.user!.id, action: "backup.disconnect_drive" });
  res.json({ connected: false });
});

backupRouter.post("/run", authorize("system.manage_settings"), async (req, res) => {
  const busy = await prisma.backupRun.count({ where: { status: { in: ["pending", "running"] } } });
  if (busy > 0) return res.status(409).json({ error: "BUSY", message: "Đang có bản backup chạy" });
  const run = await prisma.backupRun.create({ data: { id: uuid(), kind: "manual", status: "pending", triggeredBy: req.user!.id } });
  void runBackup(run.id);
  await logAudit({ actorId: req.user!.id, targetId: run.id, action: "backup.run" });
  res.status(201).json(serialize(run));
});
