import { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../../app/config.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as auth from "./auth.service.js";
import { twoFactorRouter } from "./twoFactor.routes.js";

export const authRouter = Router();

const REFRESH_COOKIE = "refresh_token";
// secure theo config.cookieSecure (COOKIE_SECURE, mặc định true ở prod). Site chạy HTTP phải đặt
// COOKIE_SECURE=false, nếu không cookie không lưu được -> reload mất phiên.
const cookieOpts = {
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: "lax" as const,
  path: "/api/auth",
  maxAge: config.refreshTtl * 1000,
};

const ctx = (req: Request) => ({ ip: req.ip, requestId: req.requestId });
const refreshCookie = (req: Request): string | undefined => req.cookies?.[REFRESH_COOKIE];

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });
// Đúng 1 trong 2: code (TOTP 6 số) hoặc recoveryCode.
const login2faSchema = z.object({
  challengeToken: z.string().min(20).max(200),
  code: z.string().trim().regex(/^\d{6}$/).optional(),
  recoveryCode: z.string().trim().min(16).max(40).optional(),
}).refine((v) => !!v.code !== !!v.recoveryCode);
const changePwSchema = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(6) });

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { email, password } = parseOr400(loginSchema, req.body);
  const result = await auth.login(email, password, ctx(req));
  // 2FA bật: chưa cấp token/cookie, client gửi challengeToken + mã ở POST /login/2fa.
  if (result.kind === "challenge") return void res.json({ twoFactorRequired: true, challengeToken: result.challengeToken });
  res.cookie(REFRESH_COOKIE, result.tokens.refresh, cookieOpts);
  res.json({ accessToken: result.tokens.access, ...(result.twoFactorSetupRequired ? { twoFactorSetupRequired: true } : {}) });
}));

authRouter.post("/login/2fa", asyncHandler(async (req, res) => {
  const p = parseOr400(login2faSchema, req.body);
  const { access, refresh } = await auth.loginSecondFactor(p.challengeToken, { code: p.code, recoveryCode: p.recoveryCode }, ctx(req));
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts);
  res.json({ accessToken: access });
}));

authRouter.use("/2fa", twoFactorRouter);

authRouter.post("/renew", asyncHandler(async (req, res) => {
  const { access, refresh } = await auth.renew(refreshCookie(req), ctx(req));
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts);
  res.json({ accessToken: access });
}));

authRouter.post("/logout", authenticate, asyncHandler(async (req, res) => {
  await auth.logout(req.user!, refreshCookie(req), ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));

authRouter.post("/change-password", authenticate, asyncHandler(async (req, res) => {
  const p = parseOr400(changePwSchema, req.body);
  await auth.changePassword(req.user!.id, p.oldPassword, p.newPassword, ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));

authRouter.post("/logout-all", authenticate, asyncHandler(async (req, res) => {
  await auth.logoutAll(req.user!.id, ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));
