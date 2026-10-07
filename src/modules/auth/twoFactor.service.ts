import crypto from "node:crypto";
import { generateSecret, generateURI, verify } from "otplib";
import QRCode from "qrcode";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import { logger } from "../../infrastructure/logger.js";
import { config } from "../../app/config.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { sha256, verifyPassword } from "./password.js";
import { decryptSecret, encryptSecret, parseKey, resolveKey } from "./totpCrypto.js";
import { isTwoFactorRequired } from "./twoFactor.policy.js";
import * as repo from "./twoFactor.repository.js";

type Ctx = { ip?: string | null; requestId?: string };

export const CHALLENGE_TTL = 300;
export const MAX_CHALLENGE_ATTEMPTS = 5;
// Chặn dò mã qua nhiều challenge/endpoint: tối đa 10 lần sai / user / 15 phút.
export const MAX_USER_FAILS = 10;
const USER_FAIL_WINDOW = 900;
const RECOVERY_CODE_COUNT = 10;
// ±1 bước thời gian (period 30s) - chịu lệch đồng hồ điện thoại.
const EPOCH_TOLERANCE = 30;

const challengeKey = (token: string) => `2fa:challenge:${sha256(token)}`;
const userFailKey = (userId: string) => `2fa:fails:${userId}`;

// ---- Mã khôi phục ----

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// 10 byte ngẫu nhiên = 80 bit -> 16 ký tự base32, hiển thị XXXX-XXXX-XXXX-XXXX.
export function generateRecoveryCode(): string {
  const bytes = crypto.randomBytes(10);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out.match(/.{4}/g)!.join("-");
}

export const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const hashRecoveryCode = (code: string) => sha256(`recovery:${normalizeRecoveryCode(code)}`);
export const isTotpCode = (code: string) => /^\d{6}$/.test(code);

// ---- Đếm lần sai theo user ----

async function assertNotLocked(userId: string) {
  const n = Number((await redis.get(userFailKey(userId))) ?? 0);
  if (n >= MAX_USER_FAILS) throw new AppError("TWO_FACTOR_TOO_MANY_ATTEMPTS", 429, "Nhập sai quá nhiều lần, thử lại sau 15 phút");
}

async function recordUserFail(userId: string) {
  const n = await redis.incr(userFailKey(userId));
  if (n === 1) await redis.expire(userFailKey(userId), USER_FAIL_WINDOW);
}

// ---- Xác minh ----

export type FactorResult = "ok" | "invalid" | "reused";

// Mã TOTP đúng chỉ dùng được 1 lần trong cửa sổ của nó: đánh dấu timeStep đã dùng bằng SET NX (an toàn khi gửi song song).
export async function verifyTotp(userId: string, encSecret: string, code: string): Promise<FactorResult> {
  if (!isTotpCode(code)) return "invalid";
  const secret = decryptSecret(encSecret);
  let res;
  try {
    res = await verify({ secret, token: code, epochTolerance: EPOCH_TOLERANCE });
  } catch {
    return "invalid";
  }
  if (!res.valid) return "invalid";
  const step = "timeStep" in res ? res.timeStep : Math.floor(Date.now() / 30_000) + res.delta;
  const fresh = await redis.set(`2fa:used:${userId}:${step}`, "1", "EX", EPOCH_TOLERANCE * 5, "NX");
  return fresh ? "ok" : "reused";
}

async function verifyRecovery(userId: string, code: string): Promise<FactorResult> {
  const norm = normalizeRecoveryCode(code);
  if (norm.length !== 16) return "invalid";
  return (await repo.consumeRecoveryCode(userId, hashRecoveryCode(norm))) ? "ok" : "invalid";
}

// `code` 6 chữ số = TOTP, còn lại coi là mã khôi phục.
async function verifySecondFactor(user: { id: string; totpSecret: string | null }, code: string): Promise<FactorResult> {
  if (isTotpCode(code)) return verifyTotp(user.id, user.totpSecret!, code);
  return verifyRecovery(user.id, code);
}

function factorError(r: FactorResult, status: number, detail?: unknown): AppError {
  return r === "reused"
    ? new AppError("TWO_FACTOR_CODE_REUSED", status, "Mã này vừa được dùng, đợi mã mới", detail)
    : new AppError("TWO_FACTOR_INVALID_CODE", status, "Mã xác thực không đúng", detail);
}

async function issueRecoveryCodes(db: Parameters<typeof repo.replaceRecoveryCodes>[0], userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  await repo.replaceRecoveryCodes(db, userId, codes.map(hashRecoveryCode));
  return codes;
}

async function loadUser(userId: string) {
  const user = await repo.findUser(userId);
  if (!user) throw new AppError("UNAUTHORIZED", 401);
  return user;
}

// ---- Self-service (đã đăng nhập) ----

export async function status(userId: string) {
  const user = await loadUser(userId);
  const roles = user.roles.map((r) => r.role.key);
  return {
    enabled: !!user.totpEnabledAt,
    enabledAt: user.totpEnabledAt,
    pending: !!user.totpSecret && !user.totpEnabledAt,
    required: isTwoFactorRequired(roles),
    recoveryCodesRemaining: user.totpEnabledAt ? await repo.countUnusedRecoveryCodes(userId) : 0,
  };
}

// Tạo secret mới ở trạng thái chờ (totpEnabledAt null) - chỉ có hiệu lực sau khi /enable xác nhận đúng mã.
export async function setup(userId: string, ctx: Ctx) {
  const user = await loadUser(userId);
  if (user.totpEnabledAt) throw new AppError("TWO_FACTOR_ALREADY_ENABLED", 409, "2FA đã bật - tắt trước khi cài lại");
  const key = resolveKey();
  const secret = generateSecret();
  await repo.setPendingSecret(userId, encryptSecret(secret, key));
  const otpauthUri = generateURI({ issuer: config.totpIssuer, label: user.email, secret });
  const qrDataUrl = await QRCode.toDataURL(otpauthUri, { errorCorrectionLevel: "M", margin: 1, width: 240 });
  await logAudit({ actorId: userId, action: "auth.2fa.setup_started", ip: ctx.ip, requestId: ctx.requestId });
  return { otpauthUri, qrDataUrl, secret };
}

export async function enable(userId: string, code: string, ctx: Ctx): Promise<{ recoveryCodes: string[] }> {
  const user = await loadUser(userId);
  if (user.totpEnabledAt) throw new AppError("TWO_FACTOR_ALREADY_ENABLED", 409, "2FA đã bật");
  if (!user.totpSecret) throw new AppError("TWO_FACTOR_NOT_PENDING", 409, "Chưa tạo mã QR - bấm thiết lập trước");
  await assertNotLocked(userId);
  const r = await verifyTotp(userId, user.totpSecret, code);
  if (r !== "ok") {
    await recordUserFail(userId);
    await logAudit({ actorId: userId, action: "auth.2fa.enable_failed", metadata: { reason: r }, ip: ctx.ip, requestId: ctx.requestId });
    throw factorError(r, 400);
  }
  const recoveryCodes = await prisma.$transaction(async (tx) => {
    await repo.markEnabled(tx, userId);
    return issueRecoveryCodes(tx, userId);
  });
  await logAudit({ actorId: userId, action: "auth.2fa.enabled", ip: ctx.ip, requestId: ctx.requestId });
  return { recoveryCodes };
}

export async function disable(userId: string, password: string, code: string, ctx: Ctx): Promise<void> {
  const user = await loadUser(userId);
  if (!user.totpEnabledAt) throw new AppError("TWO_FACTOR_NOT_ENABLED", 409, "2FA chưa bật");
  await assertNotLocked(userId);
  if (!(await verifyPassword(password, user.passwordHash))) {
    await recordUserFail(userId);
    await logAudit({ actorId: userId, action: "auth.2fa.disable_failed", metadata: { reason: "password" }, ip: ctx.ip, requestId: ctx.requestId });
    throw new AppError("INVALID_CREDENTIALS", 400, "Mật khẩu không đúng");
  }
  const r = await verifySecondFactor(user, code);
  if (r !== "ok") {
    await recordUserFail(userId);
    await logAudit({ actorId: userId, action: "auth.2fa.disable_failed", metadata: { reason: r }, ip: ctx.ip, requestId: ctx.requestId });
    throw factorError(r, 400);
  }
  await prisma.$transaction((tx) => repo.clearTotp(tx, userId));
  await logAudit({ actorId: userId, action: "auth.2fa.disabled", ip: ctx.ip, requestId: ctx.requestId });
}

export async function regenerateRecoveryCodes(userId: string, code: string, ctx: Ctx): Promise<{ recoveryCodes: string[] }> {
  const user = await loadUser(userId);
  if (!user.totpEnabledAt) throw new AppError("TWO_FACTOR_NOT_ENABLED", 409, "2FA chưa bật");
  await assertNotLocked(userId);
  const r = await verifySecondFactor(user, code);
  if (r !== "ok") {
    await recordUserFail(userId);
    throw factorError(r, 400);
  }
  const recoveryCodes = await prisma.$transaction((tx) => issueRecoveryCodes(tx, userId));
  await logAudit({ actorId: userId, action: "auth.2fa.recovery_codes_regenerated", ip: ctx.ip, requestId: ctx.requestId });
  return { recoveryCodes };
}

// ---- Đăng nhập bước 2 ----

// Token ngẫu nhiên 256 bit, Redis chỉ giữ sha256 của nó -> userId, sống 5 phút, dùng 1 lần.
export async function createChallenge(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  await redis.set(challengeKey(token), userId, "EX", CHALLENGE_TTL);
  return token;
}

export type SecondFactor = { code?: string; recoveryCode?: string };

// Trả user đã qua 2FA; auth.service cấp token. Mỗi challenge tối đa 5 lần thử (đếm trước khi xác minh -> không vượt khi gửi song song).
export async function completeChallenge(challengeToken: string, f: SecondFactor, ctx: Ctx) {
  const key = challengeKey(challengeToken);
  const userId = await redis.get(key);
  if (!userId) throw new AppError("TWO_FACTOR_CHALLENGE_INVALID", 401, "Phiên xác thực đã hết hạn, đăng nhập lại");

  const attempts = await redis.incr(`${key}:attempts`);
  if (attempts === 1) await redis.expire(`${key}:attempts`, CHALLENGE_TTL);
  if (attempts > MAX_CHALLENGE_ATTEMPTS) {
    await redis.del(key);
    throw new AppError("TWO_FACTOR_TOO_MANY_ATTEMPTS", 429, "Nhập sai quá nhiều lần, đăng nhập lại");
  }

  const user = await repo.findUser(userId);
  if (!user || !user.isActive || !user.totpEnabledAt || !user.totpSecret) {
    await redis.del(key);
    throw new AppError("TWO_FACTOR_CHALLENGE_INVALID", 401, "Phiên xác thực không còn hiệu lực, đăng nhập lại");
  }
  await assertNotLocked(user.id);

  const method = f.code ? "totp" : "recovery_code";
  const r = f.code ? await verifyTotp(user.id, user.totpSecret, f.code) : await verifyRecovery(user.id, f.recoveryCode ?? "");
  if (r !== "ok") {
    await recordUserFail(user.id);
    await logAudit({ actorId: user.id, action: "auth.login.2fa_failed", metadata: { method, reason: r, attempt: attempts }, ip: ctx.ip, requestId: ctx.requestId });
    const left = MAX_CHALLENGE_ATTEMPTS - attempts;
    if (left <= 0) {
      await redis.del(key);
      throw new AppError("TWO_FACTOR_TOO_MANY_ATTEMPTS", 429, "Nhập sai quá nhiều lần, đăng nhập lại");
    }
    throw factorError(r, 401, { attemptsLeft: left });
  }
  // DEL trả 1 đúng 1 lần -> challenge chỉ đổi được ra token 1 lần.
  if ((await redis.del(key)) !== 1) throw new AppError("TWO_FACTOR_CHALLENGE_INVALID", 401, "Phiên xác thực đã được dùng");
  await redis.del(`${key}:attempts`);
  return { user, method };
}

// ---- Admin ----

export async function adminReset(targetId: string, actor: { id: string; roles: string[]; requestId?: string }) {
  const target = await repo.findUser(targetId);
  if (!target) throw new AppError("NOT_FOUND", 404);
  if (target.roles.some((r) => r.role.key === "super_admin") && !actor.roles.includes("super_admin")) {
    throw new AppError("PROTECTED", 403, "Chỉ super admin mới reset 2FA của super admin");
  }
  const wasEnabled = !!target.totpEnabledAt;
  await prisma.$transaction((tx) => repo.clearTotp(tx, target.id));
  await logAudit({ actorId: actor.id, targetId: target.id, action: "auth.2fa.reset_by_admin", metadata: { wasEnabled }, requestId: actor.requestId, entity: "user" });
}

// Production: cảnh báo ngay lúc khởi động nếu đã có user bật 2FA mà khoá thiếu/sai (đăng nhập của họ sẽ lỗi 503).
export async function checkTotpKeyAtStartup(): Promise<void> {
  if (!config.isProd) return;
  try {
    const keyOk = !!config.totpEncKey && !!parseKey(config.totpEncKey);
    if (keyOk) return;
    const enabled = await prisma.user.count({ where: { totpSecret: { not: null } } });
    if (enabled > 0 || config.totpEncKey) {
      logger.error({ users_with_2fa: enabled }, "TOTP_ENC_KEY thiếu hoặc sai định dạng - user bật 2FA sẽ không đăng nhập được");
    }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "totp_key_startup_check_failed");
  }
}
