import crypto from "node:crypto";
import { config } from "../../app/config.js";
import { AppError } from "../../app/errors/AppError.js";
import { logger } from "../../infrastructure/logger.js";

// Mã hoá TOTP secret at-rest: AES-256-GCM, khoá từ TOTP_ENC_KEY. Định dạng lưu: v1:<iv>:<tag>:<ciphertext> (base64).
// Không bao giờ lưu plaintext: production thiếu/sai khoá -> lỗi TWO_FACTOR_NOT_CONFIGURED (503), không có fallback.
const PREFIX = "v1";

export function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, "hex");
  const b = Buffer.from(s, "base64");
  return b.length === 32 ? b : null;
}

let warnedDevKey = false;

export function resolveKey(opts: { raw?: string; isProd?: boolean; devSeed?: string } = {}): Buffer {
  const raw = opts.raw ?? config.totpEncKey;
  const isProd = opts.isProd ?? config.isProd;
  if (raw) {
    const key = parseKey(raw);
    if (!key) throw new AppError("TWO_FACTOR_NOT_CONFIGURED", 503, "TOTP_ENC_KEY không hợp lệ (cần 32 byte dạng base64 hoặc hex 64 ký tự)");
    return key;
  }
  if (isProd) throw new AppError("TWO_FACTOR_NOT_CONFIGURED", 503, "Chưa cấu hình TOTP_ENC_KEY - không thể dùng 2FA trên production");
  // Dev/test: khoá suy ra từ JWT_SECRET để chạy được khi chưa đặt env (vẫn mã hoá, không lưu plaintext).
  if (!warnedDevKey) { warnedDevKey = true; logger.warn("TOTP_ENC_KEY chưa đặt - dùng khoá dev suy ra từ JWT_SECRET"); }
  return crypto.createHash("sha256").update(`totp-dev-key:${opts.devSeed ?? config.jwtSecret}`).digest();
}

export function encryptSecret(plain: string, key: Buffer = resolveKey()): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [PREFIX, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(stored: string, key: Buffer = resolveKey()): string {
  const [v, iv, tag, ct] = stored.split(":");
  if (v !== PREFIX || !iv || !tag || !ct) {
    throw new AppError("TWO_FACTOR_NOT_CONFIGURED", 503, "Secret 2FA lưu sai định dạng");
  }
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new AppError("TWO_FACTOR_NOT_CONFIGURED", 503, "Không giải mã được secret 2FA - kiểm tra TOTP_ENC_KEY");
  }
}
