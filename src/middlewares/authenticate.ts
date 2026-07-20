import type { Request, Response, NextFunction } from "express";
import { verifyAccess } from "../utils/jwt.js";
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
  next();
}
