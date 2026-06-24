import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { parseSheetId } from "../../utils/gsheets.js";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", authorize("customers.list"), async (_req, res) => {
  const rows = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  // Gộp doanh số (tổng VND các đơn) + công nợ (tổng dư nợ) theo khách
  const [revenue, debts] = await Promise.all([
    prisma.order.groupBy({ by: ["customerId"], _sum: { totalVnd: true } }),
    prisma.debt.groupBy({ by: ["customerId"], _sum: { balance: true } }),
  ]);
  const rev = new Map(revenue.map((r) => [r.customerId, Number(r._sum.totalVnd ?? 0)]));
  const debtMap = new Map(debts.map((d) => [d.customerId, Number(d._sum.balance ?? 0)]));
  res.json(rows.map((c) => ({ ...c, revenue: rev.get(c.id) ?? 0, debt: debtMap.get(c.id) ?? 0 })));
});

const schema = z.object({
  name: z.string().min(1),
  fbZalo: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  sheetUrl: z.string().nullable().optional(),
});

function withSheet(d: Record<string, unknown>) {
  const { sheetUrl, ...rest } = d as any;
  if (sheetUrl !== undefined) rest.sheetId = parseSheetId(sheetUrl);
  return rest;
}

// Sinh mã KH-0001 tăng dần
async function nextCustomerCode(): Promise<string> {
  const last = await prisma.customer.findFirst({
    where: { code: { startsWith: "KH-" } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const n = last?.code ? parseInt(last.code.slice(3), 10) || 0 : 0;
  return `KH-${String(n + 1).padStart(4, "0")}`;
}

customersRouter.post("/", authorize("customers.create"), async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const code = await nextCustomerCode();
  const c = await prisma.customer.create({ data: { id: uuid(), code, ...withSheet(parsed.data) } });
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "customer.created" });
  res.status(201).json(c);
});

customersRouter.patch("/:id", authorize("customers.update"), async (req, res) => {
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const c = await prisma.customer.update({ where: { id: req.params.id }, data: withSheet(parsed.data) });
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "customer.updated" });
  res.json(c);
});

customersRouter.delete("/:id", authorize("customers.delete"), async (req, res) => {
  const orders = await prisma.order.count({ where: { customerId: req.params.id } });
  if (orders > 0) return res.status(409).json({ error: "HAS_ORDERS", message: "Khách còn đơn, không xóa được" });
  await prisma.customer.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "customer.deleted" });
  res.json({ ok: true });
});
