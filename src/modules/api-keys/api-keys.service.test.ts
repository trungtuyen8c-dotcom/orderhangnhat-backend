import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { apiKey: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() } },
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../middlewares/authorize.js", () => ({ loadPermissions: vi.fn() }));

import { findOverScope, createKey, revokeKey, purgeKey } from "./api-keys.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { loadPermissions } from "../../middlewares/authorize.js";

const mp = prisma as any;
const mockLoadPermissions = loadPermissions as unknown as ReturnType<typeof vi.fn>;
const user = (roles: string[]) => ({ id: "u1", tokenVersion: 0, jti: "j", exp: 0, roles });

describe("findOverScope", () => {
  beforeEach(() => vi.clearAllMocks());

  it("findOverScope_superAdmin_returnsUndefinedWithoutLoadingPermissions", async () => {
    expect(await findOverScope(user(["super_admin"]), ["reports:admin"])).toBeUndefined();
    expect(mockLoadPermissions).not.toHaveBeenCalled();
  });

  it("findOverScope_userLacksMappedPermission_returnsFirstOffendingScope", async () => {
    mockLoadPermissions.mockResolvedValue(["orders.list"]);
    expect(await findOverScope(user(["staff"]), ["orders:read", "customers:read"])).toBe("customers:read");
  });
});

describe("createKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createKey_overScope_throws403ForbiddenWithPermissionMessageAndCreatesNothing", async () => {
    mockLoadPermissions.mockResolvedValue([]);
    const err = await createKey(user(["staff"]), { name: "k", scopes: ["orders:read"] }, {}).catch((e) => e);
    expect(err.toBody()).toEqual({ error: "FORBIDDEN", message: "Bạn không có quyền: orders.list" });
    expect(mp.apiKey.create).not.toHaveBeenCalled();
  });

  it("createKey_allowed_returnsRecordWithPlaintextKeyOnce", async () => {
    mp.apiKey.create.mockResolvedValue({ id: "k1", name: "k" });
    const r = await createKey(user(["super_admin"]), { name: "k", scopes: ["orders:read"] }, {});
    expect(r.key).toMatch(/^oak_/);
    expect(mp.apiKey.create.mock.calls[0][0].data.keyHash).not.toBe(r.key);
  });
});

describe("revokeKey / purgeKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("revokeKey_keyOwnedByOtherUser_throws404NotFound", async () => {
    mp.apiKey.findUnique.mockResolvedValue({ id: "k1", userId: "other", revokedAt: null });
    await expect(revokeKey("u1", "k1", {})).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("revokeKey_alreadyRevoked_isNoopWithoutUpdate", async () => {
    mp.apiKey.findUnique.mockResolvedValue({ id: "k1", userId: "u1", revokedAt: new Date() });
    await revokeKey("u1", "k1", {});
    expect(mp.apiKey.update).not.toHaveBeenCalled();
  });

  it("purgeKey_activeKey_throws400NotRevokedAndKeepsRow", async () => {
    mp.apiKey.findUnique.mockResolvedValue({ id: "k1", userId: "u1", revokedAt: null });
    await expect(purgeKey("u1", "k1", {})).rejects.toMatchObject({ status: 400, code: "NOT_REVOKED" });
    expect(mp.apiKey.delete).not.toHaveBeenCalled();
  });
});
