import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import type { AuthUser } from "../../middlewares/authenticate.js";

const ONLINE_PREFIX = "online:";

export async function getMe(u: AuthUser) {
  const user = await prisma.user.findUnique({
    where: { id: u.id },
    select: { id: true, email: true, fullName: true },
  });
  const isSuper = u.roles.includes("super_admin");
  const perms = isSuper
    ? []
    : await prisma.permission.findMany({
        where: { roles: { some: { role: { users: { some: { userId: u.id } } } } } },
        select: { key: true },
      });
  return { ...user, roles: u.roles, permissions: isSuper ? ["*"] : perms.map((p) => p.key) };
}

// SCAN thay KEYS (KEYS chặn Redis khi nhiều key - plan P1-09).
export async function scanKeys(pattern: string, count = 200): Promise<string[]> {
  const keys = new Set<string>();
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", count);
    for (const k of batch) keys.add(k);
    cursor = next;
  } while (cursor !== "0");
  return [...keys];
}

// Nhân viên đang online: nhịp tim ghi ở middleware authenticate, TTL 90s mỗi request.
export async function listOnline() {
  const ids = (await scanKeys(`${ONLINE_PREFIX}*`)).map((k) => k.slice(ONLINE_PREFIX.length));
  if (!ids.length) return [];
  return prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, fullName: true },
  });
}
