import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { redis } from "../../redis.js";
import { config } from "../../config.js";
import { signAccess } from "../../utils/jwt.js";
import { verifyPassword, sha256 } from "../../utils/password.js";
import { logAudit } from "../../utils/audit.js";
import { authenticate } from "../../middlewares/authenticate.js";

export const authRouter = Router();

const REFRESH_COOKIE = "refresh_token";
const cookieOpts = {
  httpOnly: true,
  secure: config.nodeEnv === "production",
  sameSite: "strict" as const,
  path: "/api/auth",
  maxAge: config.refreshTtl * 1000,
};

async function issueTokens(userId: string, tokenVersion: number) {
  const jti = uuid();
  const access = signAccess({ user_id: userId, token_version: tokenVersion, jti });
  const refresh = uuid();
  await prisma.refreshToken.create({
    data: {
      id: uuid(),
      userId,
      jti,
      tokenHash: sha256(refresh),
      expiresAt: new Date(Date.now() + config.refreshTtl * 1000),
      used: false,
    },
  });
  return { access, refresh };
}

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    await logAudit({ action: "auth.login.failed", metadata: { email }, ip: req.ip });
    return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  }

  const { access, refresh } = await issueTokens(user.id, user.tokenVersion);
  await logAudit({ actorId: user.id, action: "auth.login.success", ip: req.ip });
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts);
  res.json({ accessToken: access });
});

authRouter.post("/renew", async (req, res) => {
  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (!refresh) return res.status(401).json({ error: "NO_REFRESH" });

  const row = await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(refresh) } });
  if (!row || row.expiresAt < new Date()) return res.status(401).json({ error: "INVALID_REFRESH" });

  // Reuse detection -> token bị đánh cắp
  if (row.used) {
    await prisma.refreshToken.deleteMany({ where: { userId: row.userId } });
    await prisma.user.update({ where: { id: row.userId }, data: { tokenVersion: { increment: 1 } } });
    await logAudit({ actorId: row.userId, action: "auth.refresh.reuse_detected", ip: req.ip });
    return res.status(401).json({ error: "TOKEN_REUSE" });
  }

  await prisma.refreshToken.update({ where: { id: row.id }, data: { used: true } });
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || !user.isActive) return res.status(401).json({ error: "UNAUTHORIZED" });

  const { access, refresh: newRefresh } = await issueTokens(user.id, user.tokenVersion);
  res.cookie(REFRESH_COOKIE, newRefresh, cookieOpts);
  res.json({ accessToken: access });
});

authRouter.post("/logout", authenticate, async (req, res) => {
  const u = req.user!;
  const ttl = Math.max(1, u.exp - Math.floor(Date.now() / 1000));
  await redis.set(`revoked_jti:${u.jti}`, "1", "EX", ttl);
  const refresh = req.cookies?.[REFRESH_COOKIE];
  if (refresh) await prisma.refreshToken.deleteMany({ where: { tokenHash: sha256(refresh) } });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  await logAudit({ actorId: u.id, action: "auth.logout", ip: req.ip });
  res.json({ ok: true });
});

authRouter.post("/logout-all", authenticate, async (req, res) => {
  const u = req.user!;
  await prisma.refreshToken.deleteMany({ where: { userId: u.id } });
  await prisma.user.update({ where: { id: u.id }, data: { tokenVersion: { increment: 1 } } });
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  await logAudit({ actorId: u.id, action: "auth.logout_all", ip: req.ip });
  res.json({ ok: true });
});
