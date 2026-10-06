import { Router, type Request } from "express";
import { z, type ZodTypeAny } from "zod";
import { AppError } from "../../app/errors/AppError.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { vnDayStart, vnDayEnd } from "../../app/vnTime.js";
import type { Actor } from "./accounting.repository.js";
import * as payments from "./payment.service.js";
import * as deposits from "./deposit.service.js";
import * as fund from "./fund.service.js";
import * as wallets from "./wallet.service.js";
import * as cards from "./card.service.js";
import * as reports from "./report.service.js";

// Route mỏng: quyền + validate + gọi service. Mọi thao tác tiền nằm trong service (1 transaction/thao tác).
export const accountingRouter = Router();
accountingRouter.use(authenticateEither);

export { vnDayStart, vnDayEnd };

const actor = (req: Request): Actor => ({ id: req.user!.id, requestId: req.requestId, roles: req.user!.roles });

function parseMsg<S extends ZodTypeAny>(schema: S, data: unknown, message: string): z.infer<S> {
  const p = schema.safeParse(data);
  if (!p.success) throw new AppError("BAD_REQUEST", 400, message);
  return p.data;
}

const qs = (v: unknown) => (v ? String(v) : undefined);

// ===== Thanh toán theo đơn =====
const paymentSchema = z.object({
  type: z.enum(["deposit", "final", "refund"]),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  method: z.string().optional(),
  walletId: z.string().uuid().optional(),
});

// Ghi cọc / thu nốt / hoàn -> cập nhật công nợ + ví
accountingRouter.post("/orders/:id/payments", authorize("accounting.record_payment"), asyncHandler(async (req, res) => {
  const body = parseOr400(paymentSchema, req.body);
  res.status(201).json(await payments.recordPayment(req.params.id, body, actor(req)));
}));

accountingRouter.get("/orders/:id/payments", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await payments.listOrderPayments(req.params.id));
}));

// Công nợ gộp theo khách: mỗi khách còn nợ bao nhiêu
accountingRouter.get("/debts", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await reports.debtsByCustomer());
}));

accountingRouter.get("/customers/:id/ledger", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await reports.customerLedger(req.params.id));
}));

// ===== Cọc khách (2 bước: NV ghi -> kế toán xác nhận) =====
const depositSchema = z.object({
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  payerName: z.string().optional(),
  method: z.string().optional(),
  walletId: z.string().uuid().optional(),
  note: z.string().optional(),
  paidAt: z.coerce.date().optional(),
});
accountingRouter.post("/customers/:id/deposits", authorize("accounting.note_deposit"), asyncHandler(async (req, res) => {
  const body = parseOr400(depositSchema, req.body);
  res.status(201).json(await deposits.createDeposit(req.params.id, body, actor(req)));
}));

accountingRouter.post("/customer-deposits/:id/confirm", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  res.json(await deposits.confirmDeposit(req.params.id, actor(req)));
}));

accountingRouter.post("/customer-deposits/:id/unconfirm", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  res.json(await deposits.unconfirmDeposit(req.params.id, actor(req)));
}));

// Danh sách cọc theo tab (chờ xác nhận / đã xác nhận / yêu cầu sửa / tất cả), lọc theo ngày
accountingRouter.get("/deposits", authorize("accounting.reconcile", "accounting.deposits.read"), asyncHandler(async (req, res) => {
  res.json(await deposits.listDeposits({ status: String(req.query.status ?? "pending"), from: qs(req.query.from), to: qs(req.query.to) }));
}));

accountingRouter.get("/deposits/counts", authorize("accounting.reconcile", "accounting.deposits.read"), asyncHandler(async (_req, res) => {
  res.json(await deposits.depositCounts());
}));

const fixSchema = z.object({ note: z.string().min(1) });
accountingRouter.post("/customer-deposits/:id/request-fix", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  const { note } = parseMsg(fixSchema, req.body, "Nhập nội dung yêu cầu sửa");
  await deposits.requestDepositFix(req.params.id, note, actor(req));
  res.json({ ok: true });
}));

accountingRouter.post("/customer-deposits/:id/resolve-fix", authorize("accounting.note_deposit"), asyncHandler(async (req, res) => {
  await deposits.resolveDepositFix(req.params.id, actor(req));
  res.json({ ok: true });
}));

accountingRouter.get("/deposits/fix-requests", authorize("accounting.note_deposit"), asyncHandler(async (_req, res) => {
  res.json(await deposits.depositFixRequests());
}));

// Sửa cọc đã ghi - cùng quyền người ghi cọc (NV tự sửa khi kế toán "Yêu cầu sửa").
const depEditSchema = z.object({
  payerName: z.string().optional(),
  amount: z.number().positive().optional(),
  currency: z.enum(["VND", "JPY"]).optional(),
  exchangeRate: z.number().positive().optional(),
  method: z.string().optional(),
  note: z.string().optional(),
  paidAt: z.coerce.date().optional(),
});
accountingRouter.patch("/customer-deposits/:id", authorize("accounting.note_deposit"), asyncHandler(async (req, res) => {
  const body = parseOr400(depEditSchema, req.body);
  res.json(await deposits.editDeposit(req.params.id, body, actor(req)));
}));

accountingRouter.delete("/customer-deposits/:id", authorize("accounting.record_payment"), asyncHandler(async (req, res) => {
  await deposits.deleteDeposit(req.params.id, actor(req));
  res.json({ ok: true });
}));

// ===== Số dư đầu kỳ =====
const openingSchema = z.object({ amount: z.number(), currency: z.enum(["VND", "JPY"]).default("VND"), exchangeRate: z.number().positive().optional(), note: z.string().optional() });

accountingRouter.get("/opening-balances", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await deposits.listOpeningBalances());
}));

accountingRouter.put("/customers/:id/opening-balance", authorize("accounting.record_payment"), asyncHandler(async (req, res) => {
  const body = parseOr400(openingSchema, req.body);
  res.json(await deposits.setOpeningBalance(req.params.id, body, actor(req)));
}));

accountingRouter.get("/customer-summary", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await reports.customerSummary());
}));

accountingRouter.get("/monthly-report", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await reports.monthlyReport(req.query.month));
}));

// ===== Chi phí phát sinh / đền bù khách (không động công nợ) =====
const expenseSchema = z.object({
  orderId: z.string().uuid().optional(),
  kind: z.enum(["compensation", "other"]).default("compensation"),
  amount: z.number().positive(),
  currency: z.enum(["VND", "JPY"]).default("VND"),
  exchangeRate: z.number().positive().optional(),
  note: z.string().optional(),
  incurredAt: z.coerce.date().optional(),
});
accountingRouter.post("/expenses", authorize("accounting.record_payment"), asyncHandler(async (req, res) => {
  const body = parseOr400(expenseSchema, req.body);
  res.status(201).json(await payments.createExpense(body, actor(req)));
}));

accountingRouter.get("/orders/:id/expenses", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await payments.listOrderExpenses(req.params.id));
}));

accountingRouter.delete("/expenses/:id", authorize("accounting.record_payment"), asyncHandler(async (req, res) => {
  await payments.deleteExpense(req.params.id, actor(req));
  res.json({ ok: true });
}));

accountingRouter.get("/expenses/monthly", authorize("orders.read"), asyncHandler(async (req, res) => {
  res.json(await reports.expensesMonthly(req.query.month));
}));

// ===== Ví / thẻ =====
accountingRouter.get("/wallets", authorize("accounting.reconcile", "accounting.wallets.read"), asyncHandler(async (_req, res) => {
  res.json(await wallets.listWallets());
}));

// Chỉ tên ví (không balance) - cho sale chọn PTTT khi tạo/sửa đơn
accountingRouter.get("/wallets/names", authorize("orders.create"), asyncHandler(async (_req, res) => {
  res.json(await wallets.walletNames());
}));

// id/tên/currency (không balance) - cho sale/NV mua chọn thẻ khi bấm "Đã thanh toán"
accountingRouter.get("/wallets/basic", authorize("orders.update"), asyncHandler(async (_req, res) => {
  res.json(await wallets.walletsBasic());
}));

accountingRouter.get("/wallets/:id/daily-summary", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  res.json(await reports.walletDailySummary(req.params.id, req.query.month));
}));

const dailyActualSchema = z.object({ date: z.string(), actualBalance: z.number() });
accountingRouter.put("/wallets/:id/daily-actual", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  const p = dailyActualSchema.safeParse(req.body);
  if (!p.success) throw new AppError("VALIDATION", 400, undefined, p.error.issues);
  res.json(await wallets.setDailyActual(req.params.id, p.data, actor(req)));
}));

// ===== Quỹ tổng (JPY): ghi CHỜ -> kế toán xác nhận =====
accountingRouter.post("/backfill-yahoo-dates", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  res.json(await cards.backfillYahooDates(actor(req)));
}));

accountingRouter.get("/fund", authorize("accounting.reconcile", "accounting.fund.read"), asyncHandler(async (req, res) => {
  res.json(await fund.listFund(String(req.query.status ?? "all")));
}));

accountingRouter.get("/fund/counts", authorize("accounting.reconcile", "accounting.fund.read"), asyncHandler(async (_req, res) => {
  res.json(await fund.fundCounts());
}));

const topupSchema = z.object({ amountYen: z.number().positive(), rate: z.number().positive().optional(), note: z.string().optional() });
accountingRouter.post("/fund/topup", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const p = parseOr400(topupSchema, req.body);
  res.status(201).json(await fund.recordFundTxn(
    { type: "topup", amountYen: p.amountYen, rate: p.rate ?? null, note: p.note ?? null },
    { action: "fund.topup_recorded", metadata: { amountYen: p.amountYen, rate: p.rate } },
    actor(req),
  ));
}));

const setSchema = z.object({ amountYen: z.number().nonnegative(), note: z.string().optional() });
accountingRouter.post("/fund/set", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const p = parseOr400(setSchema, req.body);
  res.status(201).json(await fund.recordFundTxn(
    { type: "set", amountYen: p.amountYen, note: p.note ?? "Đặt số dư" },
    { action: "fund.set_recorded", metadata: { amountYen: p.amountYen } },
    actor(req),
  ));
}));

const allocSchema = z.object({ walletId: z.string().uuid(), amountYen: z.number().positive(), note: z.string().optional() });
accountingRouter.post("/fund/allocate", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const p = parseOr400(allocSchema, req.body);
  res.status(201).json(await fund.recordFundTxn(
    { type: "allocate", amountYen: p.amountYen, walletId: p.walletId, note: p.note ?? null },
    { action: "fund.allocate_recorded", targetId: p.walletId, metadata: { amountYen: p.amountYen } },
    actor(req),
  ));
}));

// Cashback (tiền mua hàng được hoàn, JPY) -> cộng vào 1 thẻ sau khi xác nhận, tách riêng để báo cáo
const cashbackSchema = z.object({ walletId: z.string().uuid(), amountYen: z.number().positive(), note: z.string().optional() });
accountingRouter.post("/cashback", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const p = parseOr400(cashbackSchema, req.body);
  res.status(201).json(await cards.recordCashback(p, actor(req)));
}));

accountingRouter.post("/fund/:id/confirm", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  res.json(await fund.confirmFundTxn(req.params.id, actor(req)));
}));

accountingRouter.post("/fund/:id/unconfirm", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  res.json(await fund.unconfirmFundTxn(req.params.id, actor(req)));
}));

accountingRouter.post("/fund/:id/request-fix", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  const { note } = parseMsg(fixSchema, req.body, "Nhập nội dung yêu cầu sửa");
  await fund.requestFundFix(req.params.id, note, actor(req));
  res.json({ ok: true });
}));

accountingRouter.post("/fund/:id/resolve-fix", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  await fund.resolveFundFix(req.params.id, actor(req));
  res.json({ ok: true });
}));

accountingRouter.delete("/fund/:id", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  await fund.deleteFundTxn(req.params.id, actor(req));
  res.json({ ok: true });
}));

const walletSchema = z.object({ name: z.string().min(1), currency: z.string().default("VND"), balance: z.number().optional() });
accountingRouter.post("/wallets", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const body = parseOr400(walletSchema, req.body);
  res.status(201).json(await wallets.createWallet(body, actor(req)));
}));

accountingRouter.patch("/wallets/:id", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const body = parseOr400(walletSchema.partial(), req.body);
  res.json(await wallets.updateWallet(req.params.id, body, actor(req)));
}));

accountingRouter.delete("/wallets/:id", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  await wallets.deleteWallet(req.params.id, actor(req));
  res.json({ ok: true });
}));

// ===== Sổ giao dịch thẻ: Thu/Chi tự cộng/trừ số dư =====
const walletTxnSchema = z.object({
  walletId: z.string().uuid(),
  category: z.string(),
  amount: z.number().positive(),
  note: z.string().optional(),
  date: z.coerce.date().optional(),
  refOrderId: z.string().uuid().optional(),
});
accountingRouter.post("/wallet-txns", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const body = parseOr400(walletTxnSchema, req.body);
  res.status(201).json(await cards.recordCardTxn(body, actor(req)));
}));

// Chuyển tiền giữa 2 thẻ: 1 lần ghi -> thẻ nguồn trừ, thẻ đích cộng
const transferSchema = z.object({
  fromWalletId: z.string().uuid(),
  toWalletId: z.string().uuid(),
  amount: z.number().positive(),
  fee: z.number().nonnegative().optional(),
  note: z.string().optional(),
  date: z.coerce.date().optional(),
});
accountingRouter.post("/wallet-transfer", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  const body = parseOr400(transferSchema, req.body);
  await cards.transfer(body, actor(req));
  res.status(201).json({ ok: true });
}));

// Xóa 1 giao dịch thẻ (hoàn lại số dư). Nếu là chuyển khoản thì hoàn cả 2 vế.
accountingRouter.delete("/wallet-txns/:id", authorize("wallets.manage"), asyncHandler(async (req, res) => {
  await cards.deleteCardTxn(req.params.id, actor(req));
  res.json({ ok: true });
}));

// Đối soát: liệt kê giao dịch chưa đối soát theo ví
accountingRouter.get("/reconcile", authorize("accounting.reconcile", "accounting.reconcile_list.read"), asyncHandler(async (_req, res) => {
  res.json(await reports.unreconciledTxns());
}));

// Sao kê 1 ví: số dư lũy kế (残高) + lọc theo ngày / khách / tracking / từ khóa
accountingRouter.get("/statement", authorize("accounting.reconcile", "accounting.statement.read"), asyncHandler(async (req, res) => {
  const q = req.query;
  res.json(await reports.statement({
    walletId: typeof q.walletId === "string" ? q.walletId : null,
    from: qs(q.from), to: qs(q.to),
    customer: String(q.customer ?? ""), tracking: String(q.tracking ?? ""), q: String(q.q ?? ""),
    onlyPending: q.onlyPending === "true",
  }));
}));

const reconcileSchema = z.object({ statementRef: z.string().optional() });
accountingRouter.post("/wallet-txns/:id/reconcile", authorize("accounting.reconcile"), asyncHandler(async (req, res) => {
  const p = parseOr400(reconcileSchema, req.body);
  res.json(await cards.reconcileTxn(req.params.id, p.statementRef, actor(req)));
}));
