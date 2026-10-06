import { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import type { PageParams } from "../../app/http/pagination.js";

const DAY = 24 * 3600 * 1000;
const RANGE_MS: Record<string, number> = { "1d": DAY, "3d": 3 * DAY, "7d": 7 * DAY, "1m": 30 * DAY, "3m": 90 * DAY };
const EXPORT_LIMIT = 20000;

export type LogQuery = Record<string, unknown>;
type LogRow = { id: bigint; level: string; message: string; meta: unknown; created_at: Date };

export function sinceFromRange(range: unknown): Date {
  const key = typeof range === "string" && range in RANGE_MS ? range : "1d";
  return new Date(Date.now() - RANGE_MS[key]);
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

// range (mặc định 1d) | from/to (ISO, from thay cho range khi có), level (warn|error), q (ILIKE message/meta).
// Mọi giá trị đều là tham số bind - không nối chuỗi SQL.
export function buildWhere(query: LogQuery) {
  const since = parseDate(query.from) ?? sinceFromRange(query.range);
  const to = parseDate(query.to);
  const level = typeof query.level === "string" && ["warn", "error"].includes(query.level) ? query.level : undefined;
  const q = typeof query.q === "string" && query.q.trim() ? query.q.trim() : undefined;
  return Prisma.sql`
    WHERE created_at >= ${since}
    ${to ? Prisma.sql`AND created_at <= ${to}` : Prisma.empty}
    ${level ? Prisma.sql`AND level = ${level}` : Prisma.empty}
    ${q ? Prisma.sql`AND (message ILIKE ${"%" + q + "%"} OR meta::text ILIKE ${"%" + q + "%"})` : Prisma.empty}
  `;
}

const serialize = (r: LogRow) => ({ ...r, id: r.id.toString() });

export async function listLogs(query: LogQuery, page: PageParams | null) {
  const where = buildWhere(query);
  if (!page) {
    const take = Math.min(Number(query.limit ?? 200) || 200, 500);
    const rows = await prisma.$queryRaw<LogRow[]>`
      SELECT id, level, message, meta, created_at FROM system_logs ${where} ORDER BY created_at DESC LIMIT ${take}
    `;
    return { rows: rows.map(serialize) };
  }
  const [rows, count] = await Promise.all([
    prisma.$queryRaw<LogRow[]>`
      SELECT id, level, message, meta, created_at FROM system_logs ${where} ORDER BY created_at DESC LIMIT ${page.take} OFFSET ${page.skip}
    `,
    prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total FROM system_logs ${where}`,
  ]);
  return { rows: rows.map(serialize), total: count[0]?.total ?? 0 };
}

export function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function exportCsv(query: LogQuery): Promise<string> {
  const rows = await prisma.$queryRaw<LogRow[]>`
    SELECT id, level, message, meta, created_at FROM system_logs ${buildWhere(query)} ORDER BY created_at DESC LIMIT ${EXPORT_LIMIT}
  `;
  const header = ["id", "level", "created_at", "message", "meta"].join(",");
  const lines = rows.map((r) =>
    [csvEscape(r.id.toString()), csvEscape(r.level), csvEscape(r.created_at.toISOString()), csvEscape(r.message), csvEscape(r.meta)].join(","),
  );
  return [header, ...lines].join("\n");
}
