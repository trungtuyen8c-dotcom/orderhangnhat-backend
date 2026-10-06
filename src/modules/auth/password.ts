import bcrypt from "bcryptjs";

export const hashPassword = (pw: string) => bcrypt.hash(pw, 10);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

import crypto from "node:crypto";
export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
