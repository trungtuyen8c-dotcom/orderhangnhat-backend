import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import { config } from "../../app/config.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { signAccess } from "./jwt.js";
import { verifyPassword, hashPassword, sha256 } from "./password.js";
import type { AuthUser } from "../../middlewares/authenticate.js";
import { createChallenge, completeChallenge, type SecondFactor } from "./twoFactor.service.js";
import { needsTwoFactorSetup } from "./twoFactor.policy.js";

type Db = Prisma.TransactionClient | typeof prisma;
type Ctx = { ip?: string | null; requestId?: string };
export type TokenPair = { access: string; refresh: string };
// Bật 2FA -> chưa cấp token, trả challenge cho bước 2 (POST /login/2fa).
export type LoginResult =
  | { kind: "tokens"; tokens: TokenPair; twoFactorSetupRequired: boolean }
  | { kind: "challenge"; challengeToken: string };

async function issueTokens(db: Db, userId: string, tokenVersion: number): Promise<TokenPair> {
  const jti = uuid();
  const access = signAccess({ user_id: userId, token_version: tokenVersion, jti });
  const refresh = uuid();
  await db.refreshToken.create({
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

// Thu hồi mọi phiên của user: xoá refresh token + tăng token_version (access token cũ chết ở authenticate).
async function revokeAllSessions(db: Db, userId: string, extra: Prisma.UserUpdateInput = {}) {
  await db.refreshToken.deleteMany({ where: { userId } });
  await db.user.update({ where: { id: userId }, data: { ...extra, tokenVersion: { increment: 1 } } });
}

export async function login(email: string, password: string, ctx: Ctx): Promise<LoginResult> {
  const user = await prisma.user.findUnique({ where: { email }, include: { roles: { include: { role: true } } } });
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    await logAudit({ action: "auth.login.failed", metadata: { email }, ip: ctx.ip, requestId: ctx.requestId });
    throw new AppError("INVALID_CREDENTIALS", 401);
  }
  if (user.totpEnabledAt && user.totpSecret) {
    const challengeToken = await createChallenge(user.id);
    await logAudit({ actorId: user.id, action: "auth.login.2fa_challenge", ip: ctx.ip, requestId: ctx.requestId });
    return { kind: "challenge", challengeToken };
  }
  const tokens = await issueTokens(prisma, user.id, user.tokenVersion);
  const twoFactorSetupRequired = needsTwoFactorSetup(user, user.roles.map((r) => r.role.key));
  await logAudit({
    actorId: user.id, action: "auth.login.success",
    metadata: twoFactorSetupRequired ? { twoFactorSetupRequired } : undefined, ip: ctx.ip, requestId: ctx.requestId,
  });
  return { kind: "tokens", tokens, twoFactorSetupRequired };
}

export async function loginSecondFactor(challengeToken: string, factor: SecondFactor, ctx: Ctx): Promise<TokenPair> {
  const { user, method } = await completeChallenge(challengeToken, factor, ctx);
  const tokens = await issueTokens(prisma, user.id, user.tokenVersion);
  await logAudit({ actorId: user.id, action: "auth.login.success", metadata: { method }, ip: ctx.ip, requestId: ctx.requestId });
  return tokens;
}

// Rotation: refresh token chỉ dùng 1 lần. Gửi lại token đã dùng = nghi bị đánh cắp -> thu hồi toàn bộ phiên.
export async function renew(refresh: string | undefined, ctx: Ctx): Promise<TokenPair> {
  if (!refresh) throw new AppError("NO_REFRESH", 401);

  const row = await prisma.refreshToken.findFirst({ where: { tokenHash: sha256(refresh) } });
  if (!row || row.expiresAt < new Date()) throw new AppError("INVALID_REFRESH", 401);

  if (row.used) {
    await prisma.$transaction((tx) => revokeAllSessions(tx, row.userId));
    await logAudit({ actorId: row.userId, action: "auth.refresh.reuse_detected", ip: ctx.ip, requestId: ctx.requestId });
    throw new AppError("TOKEN_REUSE", 401);
  }

  // Token cũ luôn bị đánh dấu used (kể cả khi user đã bị khoá) - không để lại token còn tái dùng được.
  const tokens = await prisma.$transaction(async (tx) => {
    await tx.refreshToken.update({ where: { id: row.id }, data: { used: true } });
    const user = await tx.user.findUnique({ where: { id: row.userId } });
    if (!user || !user.isActive) return null;
    return issueTokens(tx, user.id, user.tokenVersion);
  });
  if (!tokens) throw new AppError("UNAUTHORIZED", 401);
  return tokens;
}

export async function logout(user: AuthUser, refresh: string | undefined, ctx: Ctx): Promise<void> {
  const ttl = Math.max(1, user.exp - Math.floor(Date.now() / 1000));
  await redis.set(`revoked_jti:${user.jti}`, "1", "EX", ttl);
  if (refresh) await prisma.refreshToken.deleteMany({ where: { tokenHash: sha256(refresh) } });
  await logAudit({ actorId: user.id, action: "auth.logout", ip: ctx.ip, requestId: ctx.requestId });
}

export async function changePassword(userId: string, oldPassword: string, newPassword: string, ctx: Ctx): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await verifyPassword(oldPassword, user.passwordHash))) {
    throw new AppError("WRONG_OLD_PASSWORD", 400);
  }
  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction((tx) => revokeAllSessions(tx, userId, { passwordHash }));
  await logAudit({ actorId: userId, action: "auth.password_changed", ip: ctx.ip, requestId: ctx.requestId });
}

export async function logoutAll(userId: string, ctx: Ctx): Promise<void> {
  await prisma.$transaction((tx) => revokeAllSessions(tx, userId));
  await logAudit({ actorId: userId, action: "auth.logout_all", ip: ctx.ip, requestId: ctx.requestId });
}
