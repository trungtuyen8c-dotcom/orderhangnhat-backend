import { Router, type Request } from "express";
import { z } from "zod";
import { config } from "../../app/config.js";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as auth from "./auth.service.js";

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
const changePwSchema = z.object({ oldPassword: z.string().min(1), newPassword: z.string().min(6) });

authRouter.post("/login", handle(async (req, res) => {
  const { email, password } = parseOr400(loginSchema, req.body);
  const { access, refresh } = await auth.login(email, password, ctx(req));
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts);
  res.json({ accessToken: access });
}));

authRouter.post("/renew", handle(async (req, res) => {
  const { access, refresh } = await auth.renew(refreshCookie(req), ctx(req));
  res.cookie(REFRESH_COOKIE, refresh, cookieOpts);
  res.json({ accessToken: access });
}));

authRouter.post("/logout", authenticate, handle(async (req, res) => {
  await auth.logout(req.user!, refreshCookie(req), ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));

authRouter.post("/change-password", authenticate, handle(async (req, res) => {
  const p = parseOr400(changePwSchema, req.body);
  await auth.changePassword(req.user!.id, p.oldPassword, p.newPassword, ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));

authRouter.post("/logout-all", authenticate, handle(async (req, res) => {
  await auth.logoutAll(req.user!.id, ctx(req));
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: 0 });
  res.json({ ok: true });
}));
