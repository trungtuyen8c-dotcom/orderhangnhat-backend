import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as backup from "./backup.service.js";

export const backupRouter = Router();
backupRouter.use(authenticate);

const actor = (req: Request) => ({ id: req.user!.id, requestId: req.requestId });
const tokenSchema = z.object({ token: z.string().min(10) });
const canManage = authorize("system.manage_settings");

backupRouter.get("/status", canManage, handle(async (_req, res) => {
  res.json(await backup.getStatus());
}));

backupRouter.get("/runs", canManage, handle(async (_req, res) => {
  res.json(await backup.listRuns());
}));

backupRouter.put("/rclone-token", canManage, handle(async (req, res) => {
  const { token } = parseOr400(tokenSchema, req.body);
  res.json(await backup.connectDrive(token.trim(), actor(req)));
}));

backupRouter.post("/disconnect", canManage, handle(async (req, res) => {
  res.json(await backup.disconnectDrive(actor(req)));
}));

backupRouter.post("/run", canManage, handle(async (req, res) => {
  res.status(201).json(await backup.startManualBackup(actor(req)));
}));
