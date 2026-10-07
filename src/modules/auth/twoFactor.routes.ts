import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticate } from "../../middlewares/authenticate.js";
import * as twoFactor from "./twoFactor.service.js";

// Mount tại /api/auth/2fa - mọi route cần đăng nhập (vẫn mở khi bị REQUIRE_2FA_ROLES bắt cài 2FA).
export const twoFactorRouter = Router();
twoFactorRouter.use(authenticate);

const ctx = (req: Request) => ({ ip: req.ip, requestId: req.requestId });
const totpSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });
// code: TOTP 6 số hoặc mã khôi phục (khi mất điện thoại).
const factorSchema = z.object({ code: z.string().trim().min(6).max(40) });
const disableSchema = factorSchema.extend({ password: z.string().min(1) });

twoFactorRouter.get("/status", asyncHandler(async (req, res) => {
  res.json(await twoFactor.status(req.user!.id));
}));

twoFactorRouter.post("/setup", asyncHandler(async (req, res) => {
  res.json(await twoFactor.setup(req.user!.id, ctx(req)));
}));

twoFactorRouter.post("/enable", asyncHandler(async (req, res) => {
  const { code } = parseOr400(totpSchema, req.body);
  res.json(await twoFactor.enable(req.user!.id, code, ctx(req)));
}));

twoFactorRouter.post("/disable", asyncHandler(async (req, res) => {
  const p = parseOr400(disableSchema, req.body);
  await twoFactor.disable(req.user!.id, p.password, p.code, ctx(req));
  res.json({ ok: true });
}));

twoFactorRouter.post("/recovery-codes", asyncHandler(async (req, res) => {
  const { code } = parseOr400(factorSchema, req.body);
  res.json(await twoFactor.regenerateRecoveryCodes(req.user!.id, code, ctx(req)));
}));
