import { v4 as uuid } from "uuid";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";

type Actor = { id: string; requestId?: string };

export async function listPayroll(month?: string) {
  const rows = await prisma.payroll.findMany({ where: month ? { month } : {}, orderBy: [{ month: "desc" }, { name: "asc" }] });
  const totalVnd = rows.reduce((s, r) => s + Number(r.amountVnd), 0);
  const paidVnd = rows.filter((r) => r.paid).reduce((s, r) => s + Number(r.amountVnd), 0);
  return { rows, totalVnd, paidVnd, unpaidVnd: totalVnd - paidVnd };
}

export async function listStaff() {
  const users = await prisma.user.findMany({ select: { id: true, fullName: true, email: true }, orderBy: { email: "asc" } });
  return users.map((u) => ({ id: u.id, name: u.fullName ?? u.email, email: u.email }));
}

export async function createPayroll(
  input: { userId?: string; name: string; month: string; amountVnd: number; note?: string },
  actor: Actor,
) {
  const r = await prisma.payroll.create({
    data: { id: uuid(), userId: input.userId ?? null, name: input.name, month: input.month, amountVnd: input.amountVnd, note: input.note ?? null },
  });
  await logAudit({ actorId: actor.id, targetId: r.id, action: "payroll.created", requestId: actor.requestId, entity: "payroll" });
  return r;
}

export async function togglePaid(id: string, actor: Actor) {
  const r = await prisma.payroll.findUnique({ where: { id } });
  if (!r) throw new AppError("NOT_FOUND", 404);
  const updated = await prisma.payroll.update({ where: { id: r.id }, data: { paid: !r.paid, paidAt: r.paid ? null : new Date() } });
  await logAudit({
    actorId: actor.id, targetId: r.id, action: "payroll.paid_toggled", requestId: actor.requestId, entity: "payroll",
    before: { paid: r.paid }, after: { paid: updated.paid },
  });
  return updated;
}

export async function deletePayroll(id: string, actor: Actor) {
  await prisma.payroll.delete({ where: { id } });
  await logAudit({ actorId: actor.id, targetId: id, action: "payroll.deleted", requestId: actor.requestId, entity: "payroll" });
}
