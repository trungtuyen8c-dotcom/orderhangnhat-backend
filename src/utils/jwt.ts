import jwt from "jsonwebtoken";
import { config } from "../config.js";

export interface AccessPayload {
  user_id: string;
  token_version: number;
  jti: string;
}

export function signAccess(payload: AccessPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: config.accessTtl });
}

export function verifyAccess(token: string): AccessPayload & { exp: number } {
  return jwt.verify(token, config.jwtSecret) as AccessPayload & { exp: number };
}
