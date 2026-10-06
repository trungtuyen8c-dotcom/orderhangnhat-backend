import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { loadPermissions } from "../../middlewares/authorize.js";
import type { AuthUser } from "../../middlewares/authenticate.js";
import { generateApiKey, API_KEY_SCOPE_TO_PERMISSION } from "./apiKey.js";

type Ctx = { ip?: string | null; requestId?: string };

const select = {
  id: true, name: true, keyPrefix: true, scopes: true, rateLimit: true,
  lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true,
} as const;

export function listKeys(userId: string) {
  return prisma.apiKey.findMany({ where: { userId }, select, orderBy: { createdAt: "desc" } });
}

// Scope đầu tiên vượt quá quyền thật của user (super_admin không bị giới hạn).
export async function findOverScope(user: AuthUser, scopes: string[]): Promise<string | undefined> {
  if (user.roles.includes("super_admin")) return undefined;
  const perms = await loadPermissions(user.id);
  return scopes.find((s) => !perms.includes(API_KEY_SCOPE_TO_PERMISSION[s]));
}

export async function createKey(
  user: AuthUser,
  input: { name: string; scopes: string[]; expiresInDays?: number; rateLimit?: number },
  ctx: Ctx,
) {
  const overScope = await findOverScope(user, input.scopes);
  if (overScope) throw new LegacyError(403, "FORBIDDEN", `Bạn không có quyền: ${API_KEY_SCOPE_TO_PERMISSION[overScope]}`);

  const { plain, prefix, hash } = generateApiKey();
  const record = await prisma.apiKey.create({
    data: {
      userId: user.id,
      name: input.name,
      keyPrefix: prefix,
      keyHash: hash,
      scopes: input.scopes,
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null,
      ...(input.rateLimit ? { rateLimit: input.rateLimit } : {}),
    },
    select,
  });
  await logAudit({ actorId: user.id, action: "api_key.created", metadata: { apiKeyId: record.id, scopes: input.scopes }, ip: ctx.ip, requestId: ctx.requestId, entity: "api_key" });
  // Plaintext trả DUY NHẤT lần này - không lưu lại, không ghi vào audit.
  return { ...record, key: plain };
}

async function findOwnKey(userId: string, id: string) {
  const key = await prisma.apiKey.findUnique({ where: { id } });
  if (!key || key.userId !== userId) throw new LegacyError(404, "NOT_FOUND");
  return key;
}

export async function revokeKey(userId: string, id: string, ctx: Ctx) {
  const key = await findOwnKey(userId, id);
  if (key.revokedAt) return;
  await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
  await logAudit({ actorId: userId, action: "api_key.revoked", metadata: { apiKeyId: key.id }, ip: ctx.ip, requestId: ctx.requestId, entity: "api_key" });
}

// Xoá hẳn - chỉ cho key đã thu hồi, tránh xoá nhầm key đang hoạt động.
export async function purgeKey(userId: string, id: string, ctx: Ctx) {
  const key = await findOwnKey(userId, id);
  if (!key.revokedAt) throw new LegacyError(400, "NOT_REVOKED", "Chỉ xoá được key đã thu hồi");
  await prisma.apiKey.delete({ where: { id: key.id } });
  await logAudit({ actorId: userId, action: "api_key.purged", metadata: { apiKeyId: key.id }, ip: ctx.ip, requestId: ctx.requestId, entity: "api_key" });
}
