import type { Request, Response, NextFunction } from "express";
import { verifyAccess } from "../utils/jwt.js";
import { hashApiKey } from "../utils/apiKey.js";
import { prisma } from "../db.js";
import { redis } from "../redis.js";

export interface AuthUser {
  id: string;
  tokenVersion: number;
  jti: string;
  exp: number;
  roles: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
      // Có giá trị khi request xác thực bằng API key thay vì JWT - authorize() sẽ ép quyền
      // giao nhau với danh sách này (xem middlewares/authorize.ts)
      apiKeyScopes?: string[];
    }
  }
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }
  const token = header.slice(7);

  let payload;
  try {
    payload = verifyAccess(token);
  } catch (e: any) {
    if (e?.name === "TokenExpiredError") {
      return res.status(401).json({ error: "TOKEN_EXPIRED" });
    }
    return res.status(401).json({ error: "INVALID_TOKEN" });
  }

  // JTI blacklist
  if (await redis.get(`revoked_jti:${payload.jti}`)) {
    return res.status(401).json({ error: "REVOKED" });
  }

  // token_version + roles
  const user = await prisma.user.findUnique({
    where: { id: payload.user_id },
    include: { roles: { include: { role: true } } },
  });
  if (!user || !user.isActive || user.tokenVersion !== payload.token_version) {
    return res.status(401).json({ error: "UNAUTHORIZED" });
  }

  req.user = {
    id: user.id,
    tokenVersion: user.tokenVersion,
    jti: payload.jti,
    exp: payload.exp,
    roles: user.roles.map((ur) => ur.role.key),
  };
  void redis.set(`online:${user.id}`, "1", "EX", 90);
  next();
}

// Xác thực bằng header X-API-Key (dùng cho tích hợp ngoài như MCP server) - không đụng JTI/online
// vì key không phải phiên đăng nhập. req.apiKeyScopes được set để authorize() ép giao quyền.
export async function authenticateApiKey(req: Request, res: Response, next: NextFunction) {
  const header = req.headers["x-api-key"];
  const key = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  if (!key) return res.status(401).json({ error: "UNAUTHORIZED" });

  const record = await prisma.apiKey.findUnique({
    where: { keyHash: hashApiKey(key) },
    include: { user: { include: { roles: { include: { role: true } } } } },
  });
  if (!record || record.revokedAt || (record.expiresAt && record.expiresAt < new Date())) {
    return res.status(401).json({ error: "INVALID_API_KEY" });
  }
  if (!record.user.isActive) return res.status(401).json({ error: "UNAUTHORIZED" });

  req.user = {
    id: record.user.id,
    tokenVersion: record.user.tokenVersion,
    jti: `apikey:${record.id}`,
    exp: Math.floor(Date.now() / 1000) + 300,
    roles: record.user.roles.map((ur) => ur.role.key),
  };
  req.apiKeyScopes = record.scopes;
  void prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  next();
}

// JWT (Bearer) hoặc API key (X-API-Key) - dùng ở các router cần mở cho cả 2 nguồn (vd. đọc dữ liệu cho MCP)
export async function authenticateEither(req: Request, res: Response, next: NextFunction) {
  if (req.headers["x-api-key"]) return authenticateApiKey(req, res, next);
  return authenticate(req, res, next);
}
