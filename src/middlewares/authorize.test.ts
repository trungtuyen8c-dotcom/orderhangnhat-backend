import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { permission: { findMany: vi.fn() } },
}));
vi.mock("../redis.js", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
vi.mock("../utils/audit.js", () => ({
  logAudit: vi.fn(),
}));

import { authorize, loadPermissions } from "./authorize.js";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { logAudit } from "../utils/audit.js";

const mockPrisma = prisma as unknown as { permission: { findMany: ReturnType<typeof vi.fn> } };
const mockRedis = redis as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
const mockLogAudit = logAudit as unknown as ReturnType<typeof vi.fn>;

function fakeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("authorize middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authorize_noUser_returns401", async () => {
    const req: any = { user: undefined, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("orders.list")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("authorize_superAdminNonSensitivePermission_callsNextWithoutAudit", async () => {
    const req: any = { user: { id: "u1", roles: ["super_admin"] }, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("orders.list")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("authorize_superAdminSystemPermission_callsNextAndLogsAudit", async () => {
    const req: any = { user: { id: "u1", roles: ["super_admin"] }, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("system.manage_settings")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "permission.checked.allowed" }));
  });

  it("authorize_superAdminRefundPermission_callsNextAndLogsAudit", async () => {
    const req: any = { user: { id: "u1", roles: ["super_admin"] }, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("accounting.refund")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "permission.checked.allowed" }));
  });

  it("authorize_nonAdminHasPermission_callsNext", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(["orders.list"]));
    const req: any = { user: { id: "u2", roles: ["staff"] }, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("orders.list")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("authorize_nonAdminMissingPermission_returns403AndLogsAudit", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(["orders.list"]));
    const req: any = { user: { id: "u2", roles: ["staff"] }, ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("system.manage_settings")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "permission.checked.denied" }));
  });

  // API key luôn bị ép giao với scopes đã cấp lúc tạo key - không được vô tình mở khóa route ghi cùng permission.
  it("authorize_apiKeyScopeMissingRequiredScope_returns403EvenIfRealPermissionGranted", async () => {
    const req: any = { user: { id: "u3", roles: ["staff"] }, apiKeyScopes: ["orders.list"], ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("accounting.reconcile")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    // Chặn ngay từ scope check, không đi tới loadPermissions (redis.get chưa từng bị gọi).
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  // Case quan trọng nhất: API key gắn với user super_admin vẫn KHÔNG được lách qua scope check.
  it("authorize_apiKeyScopeMissingRequiredScope_blocksEvenSuperAdminUser", async () => {
    const req: any = { user: { id: "u1", roles: ["super_admin"] }, apiKeyScopes: ["orders.list"], ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("system.manage_settings")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  // apiKeyScope riêng cho route đọc, tách khỏi permission thật (dùng chung với route ghi) - đúng cơ chế
  // API_KEY_SCOPE_TO_PERMISSION: key xin được "accounting.reconcile_list.read" thì vẫn phải có quyền
  // "accounting.reconcile" thật mới qua được bước kiểm tra thứ 2.
  it("authorize_apiKeyScopeUsesDistinctApiKeyScopeParam_passesWhenRealPermissionAlsoGranted", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(["accounting.reconcile"]));
    const req: any = { user: { id: "u3", roles: ["staff"] }, apiKeyScopes: ["accounting.reconcile_list.read"], ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("accounting.reconcile", "accounting.reconcile_list.read")(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("authorize_apiKeyScopeMatchesButRealPermissionMissing_returns403", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify([]));
    const req: any = { user: { id: "u3", roles: ["staff"] }, apiKeyScopes: ["orders.list"], ip: "1.1.1.1" };
    const res = fakeRes();
    const next = vi.fn();
    await authorize("orders.list")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("loadPermissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loadPermissions_cacheHit_returnsCachedWithoutQueryingDb", async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify(["a.b", "c.d"]));
    const perms = await loadPermissions("u1");
    expect(perms).toEqual(["a.b", "c.d"]);
    expect(mockPrisma.permission.findMany).not.toHaveBeenCalled();
  });

  it("loadPermissions_cacheMiss_queriesDbAndCachesResult", async () => {
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.permission.findMany.mockResolvedValue([{ key: "a.b" }, { key: "c.d" }]);
    const perms = await loadPermissions("u1");
    expect(perms).toEqual(["a.b", "c.d"]);
    expect(mockRedis.set).toHaveBeenCalledWith("perms:u1", JSON.stringify(["a.b", "c.d"]), "EX", 300);
  });
});
