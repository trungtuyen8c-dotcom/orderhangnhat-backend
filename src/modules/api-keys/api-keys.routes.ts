import { Router, type Request } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { API_KEY_ALLOWED_SCOPES } from "./apiKey.js";
import * as apiKeys from "./api-keys.service.js";

export const apiKeysRouter = Router();
// Luôn cần JWT thật (không cho API key tự tạo API key khác) - tự đăng nhập mới quản lý được key của mình.
apiKeysRouter.use(authenticate);

const ctx = (req: Request) => ({ ip: req.ip, requestId: req.requestId });

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_ALLOWED_SCOPES)).min(1),
  expiresInDays: z.number().int().positive().max(365).optional(),
  rateLimit: z.number().int().positive().max(1000).optional(),
});

apiKeysRouter.get("/", handle(async (req, res) => {
  res.json(await apiKeys.listKeys(req.user!.id));
}));

apiKeysRouter.post("/", handle(async (req, res) => {
  const body = parseOr400(createSchema, req.body, true);
  res.status(201).json(await apiKeys.createKey(req.user!, body, ctx(req)));
}));

apiKeysRouter.delete("/:id", handle(async (req, res) => {
  await apiKeys.revokeKey(req.user!.id, req.params.id, ctx(req));
  res.json({ ok: true });
}));

apiKeysRouter.delete("/:id/purge", handle(async (req, res) => {
  await apiKeys.purgeKey(req.user!.id, req.params.id, ctx(req));
  res.json({ ok: true });
}));
