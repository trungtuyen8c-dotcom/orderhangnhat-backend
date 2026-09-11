import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../../db.js";
import { redis } from "../../redis.js";
import { hashApiKey } from "../../utils/apiKey.js";
import * as reportsStats from "./reports/stats.js";
import * as reportsControl from "./reports/control.js";
import * as reportsWarehouse from "./reports/warehouse.js";
import * as reportsAdmin from "./reports/admin.js";
import * as reportsCompanycost from "./reports/companycost.js";
import * as reportsShipments from "./reports/shipments.js";
import * as reportsAccounting from "./reports/accounting.js";

// Module hoàn toàn tách biệt cho MCP (mcp-al) - CHỈ đọc Prisma trực tiếp, KHÔNG import bất kỳ
// route/controller sản xuất nào (orders.routes.ts, customers.routes.ts...) để không đụng luồng xử
// lý thật đang chạy. Auth riêng (không qua authenticate.ts/authorize.ts của hệ thống chính), chỉ
// dùng chung bảng api_keys + hàm hash. Rate limit riêng theo từng key qua Redis (không liên quan
// giới hạn theo route thật).

export const extRouter = Router();

interface ExtKey { id: string; name: string; scopes: string[]; rateLimit: number }

function requireExtScope(scope: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers["authorization"];
    const bearer = typeof header === "string" && header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined;
    const alt = typeof req.headers["x-api-key"] === "string" ? (req.headers["x-api-key"] as string).trim() : undefined;
    const raw = bearer || alt;
    if (!raw) return res.status(401).json({ error: "UNAUTHORIZED", message: "Thiếu API key" });

    const key = await prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(raw) } });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt < new Date())) {
      return res.status(401).json({ error: "UNAUTHORIZED", message: "API key không hợp lệ" });
    }
    if (scope && !key.scopes.includes(scope)) {
      return res.status(403).json({ error: "FORBIDDEN", message: `Key thiếu scope: ${scope}` });
    }

    const rlKey = `rl:ext:${key.id}`;
    const count = await redis.incr(rlKey);
    if (count === 1) await redis.expire(rlKey, 60);
    if (count > key.rateLimit) {
      return res.status(429).json({ error: "RATE_LIMITED", message: `Vượt giới hạn ${key.rateLimit} request/phút` });
    }

    void prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
    res.locals.extKey = { id: key.id, name: key.name, scopes: key.scopes, rateLimit: key.rateLimit } satisfies ExtKey;
    next();
  };
}

const clampLimit = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

extRouter.get("/me", requireExtScope(""), (_req, res) => {
  const k = res.locals.extKey as ExtKey;
  res.json({ name: k.name, scopes: k.scopes });
});

extRouter.get("/orders", requireExtScope("orders:read"), async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 50);
  const { status, source, dateFrom, dateTo } = req.query as Record<string, string | undefined>;
  const orders = await prisma.order.findMany({
    where: {
      ...(status ? { status: status as never } : {}),
      ...(source ? { source } : {}),
      ...(dateFrom || dateTo ? { orderDate: { ...(dateFrom ? { gte: new Date(dateFrom) } : {}), ...(dateTo ? { lte: new Date(`${dateTo}T23:59:59`) } : {}) } } : {}),
    },
    orderBy: { orderDate: "desc" },
    take: limit,
    select: {
      code: true, status: true, source: true, orderDate: true, createdAt: true,
      totalQuote: true, totalVnd: true, deposit: true,
      customer: { select: { name: true } },
      _count: { select: { trackings: true } },
    },
  });
  res.json({
    total_matched: orders.length, returned: orders.length,
    orders: orders.map((o) => ({
      code: o.code, status: o.status, source: o.source, customer: o.customer.name,
      orderDate: o.orderDate, totalVnd: o.totalVnd, deposit: o.deposit, trackingCount: o._count.trackings,
    })),
  });
});

extRouter.get("/orders/:code", requireExtScope("orders:read"), async (req, res) => {
  const o = await prisma.order.findUnique({
    where: { code: req.params.code },
    select: {
      code: true, status: true, source: true, orderDate: true, totalQuote: true, totalVnd: true, deposit: true,
      customer: { select: { name: true, phone: true } },
      trackings: { select: { code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, deliveredAt: true } },
    },
  });
  if (!o) return res.status(404).json({ error: "NOT_FOUND" });
  res.json(o);
});

extRouter.get("/customers", requireExtScope("customers:read"), async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 50);
  const q = String(req.query.q ?? "").trim();
  const customers = await prisma.customer.findMany({
    where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { code: { contains: q, mode: "insensitive" } }] } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { code: true, name: true, phone: true, _count: { select: { orders: true } } },
  });
  res.json({ total_matched: customers.length, returned: customers.length, customers: customers.map((c) => ({ code: c.code, name: c.name, phone: c.phone, orderCount: c._count.orders })) });
});

extRouter.get("/trackings", requireExtScope("trackings:read"), async (req, res) => {
  const limit = clampLimit(req.query.limit, 20, 50);
  const { customer, stock } = req.query as Record<string, string | undefined>;
  const trackings = await prisma.tracking.findMany({
    where: {
      ...(customer ? { order: { customer: { name: { contains: customer, mode: "insensitive" } } } } : {}),
      ...(stock === "true" ? { packedAt: { not: null }, deliveredAt: null } : {}),
    },
    orderBy: { packedAt: "desc" },
    take: limit,
    select: {
      code: true, vnTrackingCode: true, jpWeightKg: true, vnWeightKg: true, packedAt: true, deliveredAt: true,
      order: { select: { code: true, customer: { select: { name: true } } } },
    },
  });
  res.json({
    total_matched: trackings.length, returned: trackings.length,
    trackings: trackings.map((t) => ({
      code: t.code, vnTrackingCode: t.vnTrackingCode, jpWeightKg: t.jpWeightKg, vnWeightKg: t.vnWeightKg,
      packedAt: t.packedAt, deliveredAt: t.deliveredAt, orderCode: t.order?.code ?? null, customer: t.order?.customer.name ?? null,
    })),
  });
});

// Toàn bộ report chỉ đọc, mỗi report tự query Prisma trực tiếp trong reports/*.ts - không gọi lại
// route/controller sản xuất nào. params đọc thẳng từ req.query, mỗi hàm tự đọc field nó cần.
const REPORTS: Record<string, (params: Record<string, string | undefined>) => Promise<unknown>> = {
  stats_overview: reportsStats.stats_overview,
  stats_alerts: reportsStats.stats_alerts,
  control_overview: reportsControl.control_overview,
  control_debt_config: reportsControl.control_debt_config,
  control_overdue_debts: reportsControl.control_overdue_debts,
  control_cartons: reportsControl.control_cartons,
  control_unmatched: reportsControl.control_unmatched,
  warehouse_vn_board: reportsWarehouse.warehouse_vn_board,
  warehouse_stored: reportsWarehouse.warehouse_stored,
  warehouse_history: reportsWarehouse.warehouse_history,
  warehouse_recon: reportsWarehouse.warehouse_recon,
  users_list: reportsAdmin.users_list,
  roles_list: reportsAdmin.roles_list,
  permissions_list: reportsAdmin.permissions_list,
  audit_log: (p) => reportsAdmin.audit_log({ limit: p.limit ? Number(p.limit) : undefined }),
  companycost_report: reportsCompanycost.companycost_report,
  companycost_settlement: reportsCompanycost.companycost_settlement,
  companycost_reinforce_price: reportsCompanycost.companycost_reinforce_price,
  companycost_electronics_price: reportsCompanycost.companycost_electronics_price,
  shipments_tax_audit: reportsShipments.shipments_tax_audit,
  shipments_invoice_checklist: reportsShipments.shipments_invoice_checklist,
  shipments_tax_rows: reportsShipments.shipments_tax_rows,
  shipments_documents: reportsShipments.shipments_documents,
  accounting_debts: reportsAccounting.accounting_debts,
  accounting_deposits: reportsAccounting.accounting_deposits,
  accounting_deposits_counts: reportsAccounting.accounting_deposits_counts,
  accounting_opening_balances: reportsAccounting.accounting_opening_balances,
  accounting_customer_summary: reportsAccounting.accounting_customer_summary,
  accounting_monthly_report: reportsAccounting.accounting_monthly_report,
  accounting_wallets: reportsAccounting.accounting_wallets,
  accounting_fund: reportsAccounting.accounting_fund,
  accounting_fund_counts: reportsAccounting.accounting_fund_counts,
  accounting_reconcile: reportsAccounting.accounting_reconcile,
  accounting_statement: reportsAccounting.accounting_statement,
};

// Mỗi report thuộc 1 scope riêng theo mảng (kế toán/kho VN/công ty phí/...) - để phân quyền được
// theo nhân viên (vd Kho VN chỉ xin reports:warehouse, không xin được reports:accounting).
const REPORT_SCOPE: Record<string, string> = {
  stats_overview: "reports:stats", stats_alerts: "reports:stats",
  control_overview: "reports:control", control_debt_config: "reports:control", control_overdue_debts: "reports:control", control_cartons: "reports:control", control_unmatched: "reports:control",
  warehouse_vn_board: "reports:warehouse", warehouse_stored: "reports:warehouse", warehouse_history: "reports:warehouse", warehouse_recon: "reports:warehouse",
  users_list: "reports:admin", roles_list: "reports:admin", permissions_list: "reports:admin", audit_log: "reports:admin",
  companycost_report: "reports:companycost", companycost_settlement: "reports:companycost", companycost_reinforce_price: "reports:companycost", companycost_electronics_price: "reports:companycost",
  shipments_tax_audit: "reports:shipments", shipments_invoice_checklist: "reports:shipments", shipments_tax_rows: "reports:shipments", shipments_documents: "reports:shipments",
  accounting_debts: "reports:accounting", accounting_deposits: "reports:accounting", accounting_deposits_counts: "reports:accounting", accounting_opening_balances: "reports:accounting",
  accounting_customer_summary: "reports:accounting", accounting_monthly_report: "reports:accounting", accounting_wallets: "reports:accounting", accounting_fund: "reports:accounting",
  accounting_fund_counts: "reports:accounting", accounting_reconcile: "reports:accounting", accounting_statement: "reports:accounting",
};

extRouter.get("/reports", requireExtScope(""), async (req, res) => {
  const report = String(req.query.report ?? "");
  const fn = REPORTS[report];
  if (!fn) {
    return res.status(501).json({ error: "NOT_IMPLEMENTED", message: `Report "${report}" chưa được cài trong /ext`, available: Object.keys(REPORTS) });
  }
  const requiredScope = REPORT_SCOPE[report];
  const key = res.locals.extKey as ExtKey;
  if (requiredScope && !key.scopes.includes(requiredScope)) {
    return res.status(403).json({ error: "FORBIDDEN", message: `Key thiếu scope: ${requiredScope}` });
  }
  try {
    const params = req.query as Record<string, string | undefined>;
    res.json(await fn(params));
  } catch (e: any) {
    if (e?.code === "BAD_REQUEST") return res.status(400).json({ error: "BAD_REQUEST", message: e.message });
    throw e;
  }
});
