import { Router } from "express";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";

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
