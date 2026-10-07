import type { Request } from "express";
import { config } from "../../app/config.js";
import { AppError } from "../../app/errors/AppError.js";

// REQUIRE_2FA_ROLES rỗng (mặc định) = 2FA tuỳ chọn cho mọi user.
export function isTwoFactorRequired(roles: string[], requiredRoles: string[] = config.require2faRoles): boolean {
  return requiredRoles.length > 0 && roles.some((r) => requiredRoles.includes(r));
}

export function needsTwoFactorSetup(user: { totpEnabledAt: Date | null }, roles: string[], requiredRoles?: string[]): boolean {
  return !user.totpEnabledAt && isTwoFactorRequired(roles, requiredRoles);
}

// Còn mở khi bị bắt cài 2FA: /api/me (frontend biết phải hiện màn cài đặt) và /api/auth/* (setup/enable/logout).
export function isExemptPath(originalUrl: string): boolean {
  const path = originalUrl.split("?")[0].replace(/\/+$/, "");
  return path === "/api/me" || path === "/api/auth" || path.startsWith("/api/auth/");
}

// Gọi trong authenticate (JWT) sau khi đã nạp user + roles - không tốn thêm query.
export function enforceTwoFactorPolicy(req: Request, user: { totpEnabledAt: Date | null }, roles: string[]): void {
  if (needsTwoFactorSetup(user, roles) && !isExemptPath(req.originalUrl)) {
    throw new AppError("TWO_FACTOR_SETUP_REQUIRED", 403, "Tài khoản cần bật xác thực 2 lớp trước khi tiếp tục");
  }
}
