import type { Request, Response, NextFunction } from "express";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { logAudit } from "../utils/audit.js";
import { cacheHits, cacheMisses } from "./metrics.js";

const PERM_TTL = 300; // 5 phút

async function loadPermissions(userId: string): Promise<string[]> {
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

export function authorize(required: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: "UNAUTHORIZED" });

    if (user.roles.includes("super_admin")) {
      if (required.startsWith("system.") || required.includes("refund")) {
        await logAudit({ actorId: user.id, action: "permission.checked.allowed", metadata: { permission: required, via: "super_admin" }, ip: req.ip });
      }
      return next();
    }

    const perms = await loadPermissions(user.id);
    if (!perms.includes(required)) {
      await logAudit({ actorId: user.id, action: "permission.checked.denied", metadata: { permission: required }, ip: req.ip });
      return res.status(403).json({ error: "FORBIDDEN", message: `Thiếu quyền: ${required}` });
    }
    next();
  };
}
