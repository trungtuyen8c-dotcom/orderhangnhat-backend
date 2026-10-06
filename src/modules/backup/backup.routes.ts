import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as backup from "./backup.service.js";

export const backupRouter = Router();
backupRouter.use(authenticate);

const actor = (req: Request) => ({ id: req.user!.id, requestId: req.requestId });
const tokenSchema = z.object({ token: z.string().min(10) });
const canManage = authorize("system.manage_settings");

backupRouter.get("/status", canManage, asyncHandler(async (_req, res) => {
  res.json(await backup.getStatus());
}));

backupRouter.get("/runs", canManage, asyncHandler(async (_req, res) => {
  res.json(await backup.listRuns());
}));

backupRouter.put("/rclone-token", canManage, asyncHandler(async (req, res) => {
  const { token } = parseOr400(tokenSchema, req.body);
  res.json(await backup.connectDrive(token.trim(), actor(req)));
}));

backupRouter.post("/disconnect", canManage, asyncHandler(async (req, res) => {
  res.json(await backup.disconnectDrive(actor(req)));
}));

backupRouter.post("/run", canManage, asyncHandler(async (req, res) => {
  res.status(201).json(await backup.startManualBackup(actor(req)));
}));
