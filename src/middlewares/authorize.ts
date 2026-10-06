import type { Request, Response, NextFunction } from "express";
import { AppError } from "../app/errors/AppError.js";
import { prisma } from "../infrastructure/prisma.js";
import { redis } from "../infrastructure/redis.js";
import { logAudit } from "../app/audit.js";
import { cacheHits, cacheMisses } from "./metrics.js";

const PERM_TTL = 300; // 5 phút

export async function loadPermissions(userId: string): Promise<string[]> {
  const cacheKey = `perms:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) { cacheHits.inc({ feature: "permission" }); return JSON.parse(cached); }
  cacheMisses.inc({ feature: "permission" });

  const rows = await prisma.permission.findMany({
    where: { roles: { some: { role: { users: { some: { userId } } } } } },
    select: { key: true },
  });
  const keys = rows.map((r) => r.key);
  await redis.set(cacheKey, JSON.stringify(keys), "EX", PERM_TTL);
  return keys;
}

export async function invalidatePermissions(userId: string): Promise<void> {
  await redis.del(`perms:${userId}`);
}

// Kiểm tra quyền không chặn request (không audit) - dùng để lọc dữ liệu UX theo quyền người gọi,
// cùng luật với authorize: scope API key -> super_admin -> permission của role.
export async function hasPermission(req: Request, required: string): Promise<boolean> {
  const user = req.user;
  if (!user) return false;
  if (req.apiKeyScopes && !req.apiKeyScopes.includes(required)) return false;
  if (user.roles.includes("super_admin")) return true;
  return (await loadPermissions(user.id)).includes(required);
}

// apiKeyScope: tag riêng cho API key, mặc định trùng `required`. Dùng khi `required` là 1 permission
// dùng chung cho cả route đọc lẫn route ghi (vd. accounting.reconcile, warehouse.weigh_vn) - đặt tag khác
// cho route đọc để API key không bao giờ vô tình mở khóa route ghi cùng permission.
export function authorize(required: string, apiKeyScope?: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      return await check(required, apiKeyScope, req, res, next);
    } catch (e) {
      next(e);
    }
  };
}

async function check(required: string, apiKeyScope: string | undefined, req: Request, res: Response, next: NextFunction) {
  const user = req.user;
  if (!user) throw new AppError("UNAUTHORIZED", 401);

  // API key luôn bị ép giao với scopes đã cấp lúc tạo key, kể cả khi user sở hữu là super_admin
  const scope = apiKeyScope ?? required;
  if (req.apiKeyScopes && !req.apiKeyScopes.includes(scope)) {
    await logAudit({ actorId: user.id, action: "permission.checked.denied", metadata: { permission: scope, via: "api_key_scope" }, ip: req.ip, requestId: req.requestId });
    throw new AppError("FORBIDDEN", 403, `API key thiếu scope: ${scope}`);
  }

  if (user.roles.includes("super_admin")) {
    if (required.startsWith("system.") || required.includes("refund")) {
      await logAudit({ actorId: user.id, action: "permission.checked.allowed", metadata: { permission: required, via: "super_admin" }, ip: req.ip, requestId: req.requestId });
    }
    return next();
  }

  const perms = await loadPermissions(user.id);
  if (!perms.includes(required)) {
    await logAudit({ actorId: user.id, action: "permission.checked.denied", metadata: { permission: required }, ip: req.ip, requestId: req.requestId });
    throw new AppError("FORBIDDEN", 403, `Thiếu quyền: ${required}`);
  }
  next();
}
