import { Router } from "express";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { redis } from "../../redis.js";

export const meRouter = Router();

meRouter.get("/", authenticate, async (req, res) => {
  const u = req.user!;
  const user = await prisma.user.findUnique({
    where: { id: u.id },
    select: { id: true, email: true, fullName: true },
  });
  const perms = await prisma.permission.findMany({
    where: { roles: { some: { role: { users: { some: { userId: u.id } } } } } },
    select: { key: true },
  });
  res.json({
    ...user,
    roles: u.roles,
    permissions: u.roles.includes("super_admin") ? ["*"] : perms.map((p) => p.key),
  });
});

// Danh sách nhân viên đang online (nhịp tim ghi ở middleware authenticate, TTL 90s mỗi request)
meRouter.get("/online", authenticate, async (_req, res) => {
  const keys = await redis.keys("online:*");
  const ids = keys.map((k) => k.slice("online:".length));
  if (!ids.length) return res.json([]);
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, fullName: true },
  });
  res.json(users);
});
