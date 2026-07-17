import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";
import { parseSheetId, syncCustomerOrders } from "../../utils/gsheets.js";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", authorize("customers.list"), async (_req, res) => {
  const rows = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, take: 500 });
  // Gộp doanh số (tổng VND các đơn) + công nợ theo khách.
  // Công nợ VND = tổng đơn (trừ đơn đã hủy) - (cọc CustomerDeposit đã xác nhận + Payment) - tính giống
  // /accounting/customers/:id/ledger. KHÔNG dùng bảng Debt cho phần VND: bảng đó chỉ tạo/cập nhật khi có
  // Payment qua flow cũ, không biết đến cọc ghi qua Ví khách (flow hiện tại) -> nếu khách chỉ ghi cọc, Debt
  // không có dòng nào, nợ luôn hiện sai là 0.
  // Nợ ¥ (đơn định giá thẳng JPY, khách trả thẳng chưa quy đổi) vẫn lấy từ bảng Debt vì ledger không tách khoản này.
  const [revenue, debtOrders, debtJpyAgg, deposits, payments] = await Promise.all([
    prisma.order.groupBy({ by: ["customerId"], _sum: { totalVnd: true } }),
    prisma.order.groupBy({ by: ["customerId"], where: { status: { not: "cancelled" } }, _sum: { totalVnd: true } }),
    prisma.debt.groupBy({ by: ["customerId"], where: { currency: "JPY" }, _sum: { balance: true } }),
    prisma.customerDeposit.groupBy({ by: ["customerId"], where: { confirmed: true }, _sum: { amountVnd: true } }),
    prisma.payment.findMany({ select: { amountVnd: true, type: true, order: { select: { customerId: true } } } }),
  ]);
  const rev = new Map(revenue.map((r) => [r.customerId, Number(r._sum.totalVnd ?? 0)]));
  const orderTotalMap = new Map(debtOrders.map((r) => [r.customerId, Number(r._sum.totalVnd ?? 0)]));
  const debtJpyMap = new Map(debtJpyAgg.map((d) => [d.customerId, Number(d._sum.balance ?? 0)]));
  const paidMap = new Map<string, number>();
  for (const d of deposits) paidMap.set(d.customerId, (paidMap.get(d.customerId) ?? 0) + Number(d._sum.amountVnd ?? 0));
  for (const p of payments) {
    const cid = p.order?.customerId;
    if (!cid) continue;
    const v = p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd);
    paidMap.set(cid, (paidMap.get(cid) ?? 0) + v);
  }
  res.json(rows.map((c) => {
    const orderTotal = orderTotalMap.get(c.id) ?? 0;
    const paidTotal = paidMap.get(c.id) ?? 0;
    return { ...c, revenue: rev.get(c.id) ?? 0, debt: orderTotal - paidTotal, debtJpy: debtJpyMap.get(c.id) ?? 0 };
  }));
});

const schema = z.object({
  name: z.string().min(1),
  fbZalo: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  sheetUrl: z.string().nullable().optional(),
  shipRatePerKg: z.number().nonnegative().nullable().optional(),
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

// Đẩy lại toàn bộ đơn + sổ cọc cũ vào sheet khách (dùng khi mới đổi link sheet)
customersRouter.post("/:id/sync-sheet", authorize("customers.update"), async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
  if (!c) return res.status(404).json({ error: "NOT_FOUND" });
  if (!c.sheetId) return res.status(400).json({ error: "NO_SHEET", message: "Khách chưa có link Sheet" });
  await syncCustomerOrders(c.id);
  res.json({ ok: true });
});

customersRouter.delete("/:id", authorize("customers.delete"), async (req, res) => {
  const orders = await prisma.order.count({ where: { customerId: req.params.id } });
  if (orders > 0) return res.status(409).json({ error: "HAS_ORDERS", message: "Khách còn đơn, không xóa được" });
  await prisma.customer.delete({ where: { id: req.params.id } });
  await logAudit({ actorId: req.user!.id, targetId: req.params.id, action: "customer.deleted" });
  res.json({ ok: true });
});
