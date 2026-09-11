import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../../db.js";
import { redis } from "../../redis.js";
import { hashApiKey } from "../../utils/apiKey.js";

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

// Danh sách report đã cài đặt trong /ext (tập con của report cũ - mở rộng dần khi cần, mỗi report
// tự query Prisma trực tiếp, không gọi lại route/controller thật).
extRouter.get("/reports", requireExtScope("reports:read"), async (req, res) => {
  const report = String(req.query.report ?? "");
  switch (report) {
    case "stats_overview": {
      const [byStatus, customers, totalOrders] = await Promise.all([
        prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
        prisma.customer.count(),
        prisma.order.count(),
      ]);
      return res.json({ totalOrders, customers, byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })) });
    }
    case "control_overview": {
      const [unmatched, cartons] = await Promise.all([
        prisma.tracking.count({ where: { orderId: null } }),
        prisma.carton.count(),
      ]);
      return res.json({ unmatchedTrackings: unmatched, cartons });
    }
    default:
      return res.status(501).json({
        error: "NOT_IMPLEMENTED",
        message: `Report "${report}" chưa được cài trong /ext`,
        available: ["stats_overview", "control_overview"],
      });
  }
});
