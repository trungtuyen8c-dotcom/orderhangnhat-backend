import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const companyCostRouter = Router();
companyCostRouter.use(authenticate);

const mk = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
const KIND_LABEL: Record<string, string> = { chakubarai: "着払い (hàng trả sau)", weight: "Tiền cân tháng", other: "Khác" };

async function reinforceUnit(): Promise<number> {
  const c = await prisma.appConfig.findUnique({ where: { key: "reinforce_price_vnd" } });
  return Number(c?.value ?? 30000);
}

// Báo cáo phải trả kho/cty theo tháng
companyCostRouter.get("/report", authorize("accounting.reconcile"), async (req, res) => {
  const month = typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : mk(new Date());
  const unit = await reinforceUnit();

  // Gia cố/check: đếm đơn needsCheck có tracking đóng hàng trong tháng
  const checkTrks = await prisma.tracking.findMany({
    where: { packedAt: { not: null }, order: { needsCheck: true } },
    select: { packedAt: true, orderId: true },
  });
  const reinforceOrders = new Set<string>();
  for (const t of checkTrks) if (t.packedAt && mk(t.packedAt) === month && t.orderId) reinforceOrders.add(t.orderId);
  const reinforceCount = reinforceOrders.size;
  const reinforceVnd = reinforceCount * unit;

  // Entry nhập tay (chakubarai, weight, other)
  const entries = await prisma.companyCost.findMany({ where: { month }, orderBy: { createdAt: "desc" } });
  const ser = entries.map((e) => ({
    id: e.id, kind: e.kind, kindLabel: KIND_LABEL[e.kind] ?? e.kind, amountVnd: Number(e.amountVnd),
    currency: e.currency, amountOrig: Number(e.amountOrig), exchangeRate: e.exchangeRate ? Number(e.exchangeRate) : null,
    note: e.note, paid: e.paid, createdAt: e.createdAt,
  }));
  const byKind: Record<string, number> = { reinforce: reinforceVnd };
  for (const e of ser) byKind[e.kind] = (byKind[e.kind] ?? 0) + e.amountVnd;
  const totalVnd = reinforceVnd + ser.reduce((s, e) => s + e.amountVnd, 0);
  const paidVnd = ser.filter((e) => e.paid).reduce((s, e) => s + e.amountVnd, 0);

  res.json({
    month, reinforceCount, reinforceUnit: unit, reinforceVnd,
    entries: ser, byKind, totalVnd, paidVnd, unpaidVnd: totalVnd - paidVnd,
  });
});

const entrySchema = z.object({
  kind: z.enum(["chakubarai", "weight", "other"]),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  note: z.string().optional(),
});
companyCostRouter.post("/", authorize("accounting.record_payment"), async (req, res) => {
  const p = entrySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  if (p.data.currency === "JPY" && !p.data.exchangeRate) return res.status(400).json({ error: "BAD_REQUEST", message: "Nhập JPY cần tỉ giá" });
  const amountVnd = p.data.currency === "JPY" ? Math.round(p.data.amount * p.data.exchangeRate!) : p.data.amount;
  const c = await prisma.companyCost.create({ data: {
    id: uuid(), kind: p.data.kind, month: p.data.month, amountVnd, currency: p.data.currency,
    amountOrig: p.data.amount, exchangeRate: p.data.exchangeRate ?? null, note: p.data.note ?? null,
  } });
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "company_cost.created", metadata: { kind: c.kind, amountVnd } });
  res.status(201).json(c);
});

companyCostRouter.patch("/:id/paid", authorize("accounting.record_payment"), async (req, res) => {
  const c = await prisma.companyCost.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "NOT_FOUND" });
  const updated = await prisma.companyCost.update({ where: { id: c.id }, data: { paid: !c.paid } });
  res.json(updated);
});

companyCostRouter.delete("/:id", authorize("accounting.record_payment"), async (req, res) => {
  await prisma.companyCost.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "company_cost.deleted" });
  res.json({ ok: true });
});

// Cấu hình đơn giá gia cố
companyCostRouter.get("/reinforce-price", authorize("accounting.reconcile"), async (_req, res) => {
  res.json({ unit: await reinforceUnit() });
});
companyCostRouter.put("/reinforce-price", authorize("system.manage_settings"), async (req, res) => {
  const p = z.object({ unit: z.number().nonnegative() }).safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  await prisma.appConfig.upsert({ where: { key: "reinforce_price_vnd" }, update: { value: String(p.data.unit) }, create: { key: "reinforce_price_vnd", value: String(p.data.unit) } });
  res.json({ unit: p.data.unit });
});
