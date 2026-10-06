import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    apiKey: { findUnique: vi.fn(), update: vi.fn() },
    order: { findMany: vi.fn(), findUnique: vi.fn() },
    customer: { findMany: vi.fn() },
    tracking: { findMany: vi.fn() },
  },
}));
vi.mock("../../infrastructure/redis.js", () => ({ redis: { incr: vi.fn(), expire: vi.fn() } }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

// Thay toàn bộ report bằng mock: test chỉ kiểm tra dispatcher + scope gating, không chạy query thật.
vi.mock("./ext.reports.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ext.reports.js")>();
  const REPORTS = Object.fromEntries(Object.keys(actual.REPORTS).map((k) => [k, vi.fn(async () => ({ report: k }))]));
  return { REPORTS, REPORT_SCOPE: actual.REPORT_SCOPE };
});

import { extRouter } from "./ext.routes.js";
import { REPORTS, REPORT_SCOPE } from "./ext.reports.js";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";
import { logWarn } from "../../infrastructure/systemLog.js";
import { hashApiKey } from "../api-keys/apiKey.js";
import { errorHandler } from "../../app/errors/errorHandler.js";

const mp = prisma as any;
const mr = redis as any;

function buildApp() {
  const app = express();
  app.use("/api/ext", extRouter);
  app.use(errorHandler);
  return app;
}

const RAW = "ak_test_key";
function keyRow(over: Record<string, unknown> = {}) {
  return { id: "k1", name: "mcp", scopes: [] as string[], rateLimit: 60, revokedAt: null, expiresAt: null, user: { isActive: true }, ...over };
}
function withKey(scopes: string[], over: Record<string, unknown> = {}) {
  mp.apiKey.findUnique.mockResolvedValue(keyRow({ scopes, ...over }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mr.incr.mockResolvedValue(1);
  mr.expire.mockResolvedValue(1);
  mp.apiKey.update.mockResolvedValue({});
});

describe("ext auth (requireExtScope)", () => {
  it("auth_noKeyHeader_returns401MissingKey", async () => {
    const res = await request(buildApp()).get("/api/ext/me");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED", message: "Thiếu API key" });
    expect(mp.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it("auth_bearerKey_looksUpByHashNotPlaintext", async () => {
    withKey([]);
    await request(buildApp()).get("/api/ext/me").set("Authorization", `Bearer ${RAW}`);
    expect(mp.apiKey.findUnique).toHaveBeenCalledWith({ where: { keyHash: hashApiKey(RAW) }, include: { user: { select: { isActive: true } } } });
  });

  it("auth_keyOwnerDeactivated_returns401", async () => {
    withKey([], { user: { isActive: false } });
    const res = await request(buildApp()).get("/api/ext/me").set("Authorization", `Bearer ${RAW}`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED", message: "API key không hợp lệ" });
  });

  it("auth_xApiKeyHeader_isAcceptedAsAlternative", async () => {
    withKey([]);
    const res = await request(buildApp()).get("/api/ext/me").set("x-api-key", RAW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "mcp", scopes: [] });
  });

  it("auth_unknownKey_returns401Invalid", async () => {
    mp.apiKey.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get("/api/ext/me").set("x-api-key", RAW);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED", message: "API key không hợp lệ" });
  });

  it("auth_revokedKey_returns401Invalid", async () => {
    withKey(["orders:read"], { revokedAt: new Date() });
    const res = await request(buildApp()).get("/api/ext/orders").set("x-api-key", RAW);
    expect(res.status).toBe(401);
  });

  it("auth_expiredKey_returns401Invalid", async () => {
    withKey(["orders:read"], { expiresAt: new Date(Date.now() - 1000) });
    const res = await request(buildApp()).get("/api/ext/orders").set("x-api-key", RAW);
    expect(res.status).toBe(401);
  });

  it("auth_keyMissingEndpointScope_returns403WithScopeName", async () => {
    withKey(["customers:read"]);
    const res = await request(buildApp()).get("/api/ext/orders").set("x-api-key", RAW);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "FORBIDDEN", message: "Key thiếu scope: orders:read" });
    expect(mp.order.findMany).not.toHaveBeenCalled();
  });

  it("auth_overRateLimit_returns429", async () => {
    withKey(["orders:read"], { rateLimit: 5 });
    mr.incr.mockResolvedValue(6);
    const res = await request(buildApp()).get("/api/ext/orders").set("x-api-key", RAW);
    expect(res.status).toBe(429);
    expect(res.body).toEqual({ error: "RATE_LIMITED", message: "Vượt giới hạn 5 request/phút" });
  });

  it("auth_firstRequestInWindow_setsRateLimitExpiry60s", async () => {
    withKey([]);
    await request(buildApp()).get("/api/ext/me").set("x-api-key", RAW);
    expect(mr.incr).toHaveBeenCalledWith("rl:ext:k1");
    expect(mr.expire).toHaveBeenCalledWith("rl:ext:k1", 60);
  });

  it("auth_lastUsedUpdateFails_requestStillSucceedsAndFailureIsLogged", async () => {
    withKey([]);
    mp.apiKey.update.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get("/api/ext/me").set("x-api-key", RAW);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ api_key_id: "k1", err: "db down" }), "ext_api_key_last_used_update_failed");
  });

  it("auth_keyLookupThrows_returns500InsteadOfHanging", async () => {
    mp.apiKey.findUnique.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).get("/api/ext/me").set("x-api-key", RAW);
    expect(res.status).toBe(500);
  });
});

describe("ext read endpoints", () => {
  it("orders_limitAboveMax_isClampedTo50", async () => {
    withKey(["orders:read"]);
    mp.order.findMany.mockResolvedValue([]);
    const res = await request(buildApp()).get("/api/ext/orders?limit=999").set("x-api-key", RAW);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ total_matched: 0, returned: 0, orders: [] });
    expect(mp.order.findMany.mock.calls[0][0].take).toBe(50);
  });

  it("orderByCode_notFound_returns404", async () => {
    withKey(["orders:read"]);
    mp.order.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get("/api/ext/orders/X1").set("x-api-key", RAW);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });

  it("customers_mapsOrderCount", async () => {
    withKey(["customers:read"]);
    mp.customer.findMany.mockResolvedValue([{ code: "KH-0001", name: "A", phone: null, _count: { orders: 3 } }]);
    const res = await request(buildApp()).get("/api/ext/customers?q=a").set("x-api-key", RAW);
    expect(res.body).toEqual({ total_matched: 1, returned: 1, customers: [{ code: "KH-0001", name: "A", phone: null, orderCount: 3 }] });
  });

  it("trackings_requiresTrackingsScope", async () => {
    withKey(["orders:read"]);
    const res = await request(buildApp()).get("/api/ext/trackings").set("x-api-key", RAW);
    expect(res.status).toBe(403);
  });
});

describe("ext /reports dispatcher", () => {
  it("reports_unknownReport_returns501WithAvailableList", async () => {
    withKey([]);
    const res = await request(buildApp()).get("/api/ext/reports?report=nope").set("x-api-key", RAW);
    expect(res.status).toBe(501);
    expect(res.body.error).toBe("NOT_IMPLEMENTED");
    expect(res.body.detail.available).toEqual(Object.keys(REPORTS));
  });

  it("reports_everyReportHasAScope", () => {
    expect(Object.keys(REPORT_SCOPE).sort()).toEqual(Object.keys(REPORTS).sort());
  });

  for (const [report, scope] of Object.entries(REPORT_SCOPE)) {
    it(`reports_${report}_withScope_${scope}_dispatchesToItsHandler`, async () => {
      withKey([scope]);
      const res = await request(buildApp()).get(`/api/ext/reports?report=${report}&month=2026-03`).set("x-api-key", RAW);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ report });
      expect(REPORTS[report]).toHaveBeenCalledTimes(1);
      expect((REPORTS[report] as any).mock.calls[0][0]).toEqual(expect.objectContaining({ report, month: "2026-03" }));
    });

    it(`reports_${report}_withoutScope_returns403AndDoesNotRun`, async () => {
      withKey(["orders:read", "customers:read", "trackings:read"]);
      const res = await request(buildApp()).get(`/api/ext/reports?report=${report}`).set("x-api-key", RAW);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "FORBIDDEN", message: `Key thiếu scope: ${scope}` });
      expect(REPORTS[report]).not.toHaveBeenCalled();
    });
  }

  it("reports_auditLog_passesLimitAsNumber", async () => {
    withKey(["reports:admin"]);
    await request(buildApp()).get("/api/ext/reports?report=audit_log&limit=7").set("x-api-key", RAW);
    expect((REPORTS.audit_log as any).mock.calls[0][0]).toEqual(expect.objectContaining({ limit: "7" }));
  });

  it("reports_handlerThrowsLegacyBadRequestCode_returns400WithMessage", async () => {
    withKey(["reports:accounting"]);
    (REPORTS.accounting_statement as any).mockRejectedValueOnce(Object.assign(new Error("Thiếu walletId"), { code: "BAD_REQUEST" }));
    const res = await request(buildApp()).get("/api/ext/reports?report=accounting_statement").set("x-api-key", RAW);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST", message: "Thiếu walletId" });
  });

  it("reports_handlerThrowsUnexpected_returns500", async () => {
    withKey(["reports:stats"]);
    (REPORTS.stats_overview as any).mockRejectedValueOnce(new Error("boom"));
    const res = await request(buildApp()).get("/api/ext/reports?report=stats_overview").set("x-api-key", RAW);
    expect(res.status).toBe(500);
  });
});
