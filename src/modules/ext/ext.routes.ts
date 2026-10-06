import { Router } from "express";
import { AppError } from "../../app/errors/AppError.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { requireExtScope, type ExtKey } from "./ext.auth.js";
import { REPORTS, REPORT_SCOPE, type ReportParams } from "./ext.reports.js";
import * as ext from "./ext.service.js";

// Kênh chỉ đọc cho MCP (mcp-al): auth bằng API key + scope (ext.auth.ts), không qua authenticate/authorize của
// hệ thống chính. Report đọc qua service của từng module (xem ext.reports.ts) - không có side-effect ghi.

export const extRouter = Router();

extRouter.get("/me", requireExtScope(""), (_req, res) => {
  const k = res.locals.extKey as ExtKey;
  res.json({ name: k.name, scopes: k.scopes });
});

extRouter.get("/orders", requireExtScope("orders:read"), asyncHandler(async (req, res) => {
  const { status, source, dateFrom, dateTo } = req.query as Record<string, string | undefined>;
  res.json(await ext.listOrders({ limit: ext.clampLimit(req.query.limit, 20, 50), status, source, dateFrom, dateTo }));
}));

extRouter.get("/orders/:code", requireExtScope("orders:read"), asyncHandler(async (req, res) => {
  const o = await ext.getOrder(req.params.code);
  if (!o) throw new AppError("NOT_FOUND", 404);
  res.json(o);
}));

extRouter.get("/customers", requireExtScope("customers:read"), asyncHandler(async (req, res) => {
  res.json(await ext.listCustomers({ limit: ext.clampLimit(req.query.limit, 20, 50), q: String(req.query.q ?? "").trim() }));
}));

extRouter.get("/trackings", requireExtScope("trackings:read"), asyncHandler(async (req, res) => {
  const { customer, stock } = req.query as Record<string, string | undefined>;
  res.json(await ext.listTrackings({ limit: ext.clampLimit(req.query.limit, 20, 50), customer, stock }));
}));

extRouter.get("/reports", requireExtScope(""), asyncHandler(async (req, res) => {
  const report = String(req.query.report ?? "");
  const fn = REPORTS[report];
  if (!fn) {
    throw new AppError("NOT_IMPLEMENTED", 501, `Report "${report}" chưa được cài trong /ext`, { available: Object.keys(REPORTS) });
  }
  const requiredScope = REPORT_SCOPE[report];
  const key = res.locals.extKey as ExtKey;
  if (requiredScope && !key.scopes.includes(requiredScope)) {
    throw new AppError("FORBIDDEN", 403, `Key thiếu scope: ${requiredScope}`);
  }
  try {
    res.json(await fn(req.query as ReportParams));
  } catch (e) {
    // Report cũ (accounting/warehouse) báo tham số sai bằng Error có code "BAD_REQUEST".
    const err = e as { code?: unknown; message?: string };
    if (!(e instanceof AppError) && err?.code === "BAD_REQUEST") throw new AppError("BAD_REQUEST", 400, err.message);
    throw e;
  }
}));
