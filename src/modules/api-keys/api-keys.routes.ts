import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { loadPermissions } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { generateApiKey, API_KEY_ALLOWED_SCOPES, API_KEY_SCOPE_TO_PERMISSION } from "../../utils/apiKey.js";

export const apiKeysRouter = Router();
// Luôn cần JWT thật (không cho API key tự tạo API key khác) - tự đăng nhập mới quản lý được key của mình.
apiKeysRouter.use(authenticate);

const select = {
  id: true, name: true, keyPrefix: true, scopes: true,
  lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
} as const;

apiKeysRouter.get("/", async (req, res) => {
  const keys = await prisma.apiKey.findMany({
    where: { userId: req.user!.id },
    select,
    orderBy: { createdAt: "desc" },
  });
  res.json(keys);
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(API_KEY_ALLOWED_SCOPES)).min(1),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

apiKeysRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST", detail: parsed.error.flatten() });
  const { name, scopes, expiresInDays } = parsed.data;

  // Không cho scope vượt quá quyền thật của user đang đăng nhập lúc tạo key
  const userPerms = req.user!.roles.includes("super_admin") ? null : await loadPermissions(req.user!.id);
  const overScope = userPerms ? scopes.find((s) => !userPerms.includes(API_KEY_SCOPE_TO_PERMISSION[s])) : undefined;
  if (overScope) {
    return res.status(403).json({ error: "FORBIDDEN", message: `Bạn không có quyền: ${API_KEY_SCOPE_TO_PERMISSION[overScope]}` });
  }

  const { plain, prefix, hash } = generateApiKey();
  const record = await prisma.apiKey.create({
    data: {
      userId: req.user!.id,
      name,
      keyPrefix: prefix,
      keyHash: hash,
      scopes,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400_000) : null,
    },
    select,
  });
  await logAudit({ actorId: req.user!.id, action: "api_key.created", metadata: { apiKeyId: record.id, scopes }, ip: req.ip });

  // Trả plaintext DUY NHẤT lần này - không lưu lại, không log ra ngoài audit metadata.
  res.status(201).json({ ...record, key: plain });
});

apiKeysRouter.delete("/:id", async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key || key.userId !== req.user!.id) return res.status(404).json({ error: "NOT_FOUND" });
  if (key.revokedAt) return res.json({ ok: true });

  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  await logAudit({ actorId: req.user!.id, action: "api_key.revoked", metadata: { apiKeyId: key.id }, ip: req.ip });
  res.json({ ok: true });
});

// Xoá hẳn khỏi bảng - chỉ cho key đã thu hồi, tránh xoá nhầm key đang hoạt động.
apiKeysRouter.delete("/:id/purge", async (req, res) => {
  const key = await prisma.apiKey.findUnique({ where: { id: req.params.id } });
  if (!key || key.userId !== req.user!.id) return res.status(404).json({ error: "NOT_FOUND" });
  if (!key.revokedAt) return res.status(400).json({ error: "NOT_REVOKED", message: "Chỉ xoá được key đã thu hồi" });

  await prisma.apiKey.delete({ where: { id: key.id } });
  await logAudit({ actorId: req.user!.id, action: "api_key.purged", metadata: { apiKeyId: key.id }, ip: req.ip });
  res.json({ ok: true });
});
