import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";

export const systemLogsRouter = Router();
systemLogsRouter.use(authenticate);

const RANGE_MS: Record<string, number> = {
  "1d": 1 * 24 * 3600 * 1000,
  "3d": 3 * 24 * 3600 * 1000,
  "7d": 7 * 24 * 3600 * 1000,
  "1m": 30 * 24 * 3600 * 1000,
  "3m": 90 * 24 * 3600 * 1000,
};

function sinceFromRange(range: unknown): Date {
  const key = typeof range === "string" && range in RANGE_MS ? range : "1d";
  return new Date(Date.now() - RANGE_MS[key]);
}

type LogRow = { id: bigint; level: string; message: string; meta: unknown; created_at: Date };

function buildWhere(req: Request) {
  const since = sinceFromRange(req.query.range);
  const level = typeof req.query.level === "string" && ["warn", "error"].includes(req.query.level) ? req.query.level : undefined;
  const q = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
  return Prisma.sql`
    WHERE created_at >= ${since}
    ${level ? Prisma.sql`AND level = ${level}` : Prisma.empty}
    ${q ? Prisma.sql`AND (message ILIKE ${"%" + q + "%"} OR meta::text ILIKE ${"%" + q + "%"})` : Prisma.empty}
  `;
}

systemLogsRouter.get("/", authorize("system.manage_settings"), async (req, res) => {
  const where = buildWhere(req);
  const take = Math.min(Number(req.query.limit ?? 200) || 200, 500);
  const rows = await prisma.$queryRaw<LogRow[]>`
    SELECT id, level, message, meta, created_at FROM system_logs ${where} ORDER BY created_at DESC LIMIT ${take}
  `;
  res.json(rows.map((r) => ({ ...r, id: r.id.toString() })));
});

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return `"${s.replace(/"/g, '""')}"`;
}

systemLogsRouter.get("/export", authorize("system.manage_settings"), async (req, res) => {
  const where = buildWhere(req);
  const rows = await prisma.$queryRaw<LogRow[]>`
    SELECT id, level, message, meta, created_at FROM system_logs ${where} ORDER BY created_at DESC LIMIT 20000
  `;
  const header = ["id", "level", "created_at", "message", "meta"].join(",");
  const lines = rows.map((r) =>
    [csvEscape(r.id.toString()), csvEscape(r.level), csvEscape(r.created_at.toISOString()), csvEscape(r.message), csvEscape(r.meta)].join(","),
  );
  const csv = [header, ...lines].join("\n");
  const range = typeof req.query.range === "string" ? req.query.range : "1d";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="system-logs-${range}.csv"`);
  res.send("﻿" + csv);
});
