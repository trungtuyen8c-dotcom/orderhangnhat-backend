import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import { logWarn } from "../../infrastructure/systemLog.js";
import { hashApiKey } from "../api-keys/apiKey.js";

// Auth riêng cho kênh /api/ext (MCP mcp-al) - không qua authenticate.ts/authorize.ts của hệ thống chính,
// chỉ dùng chung bảng api_keys + hàm hash. Rate limit riêng theo từng key qua Redis.

export interface ExtKey { id: string; name: string; scopes: string[]; rateLimit: number }

function readRawKey(req: Request): string | undefined {
  const header = req.headers["authorization"];
  const bearer = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
  const alt = typeof req.headers["x-api-key"] === "string" ? (req.headers["x-api-key"] as string).trim() : undefined;
  return bearer || alt;
}

// scope "" = chỉ cần key hợp lệ (scope cụ thể kiểm tra sau, vd /reports theo từng report).
export function requireExtScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    checkKey(scope, req, res, next).catch(next);
  };
}

async function checkKey(scope: string, req: Request, res: Response, next: NextFunction) {
  const raw = readRawKey(req);
  if (!raw) return res.status(401).json({ error: "UNAUTHORIZED", message: "Thiếu API key" });

  const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
  if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) {
    return res.status(401).json({ error: "UNAUTHORIZED", message: "API key không hợp lệ" });
  }
  if (scope && !key.scopes.includes(scope)) {
    return res.status(403).json({ error: "FORBIDDEN", message: `Key thiếu scope: ${scope}` });
  }

  const rlKey = `rl:ext:${key.id}`;
  const count = await redis.incr(rlKey);
  if (count === 1) await redis.expire(rlKey, 60);
  if (count > key.rateLimit) {
    return res.status(429).json({ error: "RATE_LIMITED", message: `Vượt giới hạn ${key.rateLimit} request/phút` });
  }

  // lastUsedAt chỉ để tham khảo - ghi lỗi thì log, không chặn request đọc.
  void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
    .catch((e) => logWarn({ api_key_id: key.id, err: (e as Error).message }, "ext_api_key_last_used_update_failed"));
  res.locals.extKey = { id: key.id, name: key.name, scopes: key.scopes, rateLimit: key.rateLimit } satisfies ExtKey;
  next();
}
