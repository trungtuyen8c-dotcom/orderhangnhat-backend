import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { paged, readPage } from "../../app/http/pagination.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { exportCsv, listLogs } from "./system-logs.service.js";

export const systemLogsRouter = Router();
systemLogsRouter.use(authenticate);

// Mặc định trả mảng (tối đa ?limit, max 500). Có ?page= -> { items, pagination }.
systemLogsRouter.get("/", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  const page = readPage(req, 100, 500);
  const { rows, total } = await listLogs(req.query, page);
  res.json(page ? paged(rows, total ?? 0, page) : rows);
}));

systemLogsRouter.get("/export", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  const csv = await exportCsv(req.query);
  const range = typeof req.query.range === "string" ? req.query.range : "1d";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="system-logs-${range}.csv"`);
  res.send("﻿" + csv);
}));
