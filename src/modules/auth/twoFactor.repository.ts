import { v4 as uuid } from "uuid";
import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const findUser = (id: string) =>
  prisma.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });

export const findUserByEmail = (email: string) =>
  prisma.user.findUnique({ where: { email }, include: { roles: { include: { role: true } } } });

export const setPendingSecret = (userId: string, encSecret: string) =>
  prisma.user.update({ where: { id: userId }, data: { totpSecret: encSecret, totpEnabledAt: null } });

export const markEnabled = (db: Db, userId: string) =>
  db.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date() } });

export async function clearTotp(db: Db, userId: string) {
  await db.userRecoveryCode.deleteMany({ where: { userId } });
  await db.user.update({ where: { id: userId }, data: { totpSecret: null, totpEnabledAt: null } });
}

export async function replaceRecoveryCodes(db: Db, userId: string, hashes: string[]) {
  await db.userRecoveryCode.deleteMany({ where: { userId } });
  await db.userRecoveryCode.createMany({ data: hashes.map((codeHash) => ({ id: uuid(), userId, codeHash })) });
}

// Dùng 1 lần: chỉ thành công khi mã thuộc đúng user và chưa dùng (updateMany có điều kiện -> an toàn khi gửi song song).
export async function consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
  const r = await prisma.userRecoveryCode.updateMany({ where: { userId, codeHash, usedAt: null }, data: { usedAt: new Date() } });
  return r.count === 1;
}

export const countUnusedRecoveryCodes = (userId: string) =>
  prisma.userRecoveryCode.count({ where: { userId, usedAt: null } });
