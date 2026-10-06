import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn(), findMany: vi.fn() }, permission: { findMany: vi.fn() } },
}));

import { getMe, listOnline, scanKeys } from "./me.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { redis } from "../../infrastructure/redis.js";

const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  permission: { findMany: ReturnType<typeof vi.fn> };
};
const mockScan = (redis as unknown as { scan: ReturnType<typeof vi.fn> }).scan;
const user = (roles: string[]) => ({ id: "u1", tokenVersion: 0, jti: "j", exp: 0, roles });

describe("scanKeys", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scanKeys_multipleCursorPages_followsCursorUntilZeroAndDedupes", async () => {
    mockScan.mockResolvedValueOnce(["7", ["online:a", "online:b"]]).mockResolvedValueOnce(["0", ["online:b", "online:c"]]);
    const keys = await scanKeys("online:*");
    expect(keys).toEqual(["online:a", "online:b", "online:c"]);
    expect(mockScan).toHaveBeenNthCalledWith(1, "0", "MATCH", "online:*", "COUNT", 200);
    expect(mockScan).toHaveBeenNthCalledWith(2, "7", "MATCH", "online:*", "COUNT", 200);
  });
});

describe("listOnline", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listOnline_noOnlineKeys_returnsEmptyArrayWithoutQueryingDb", async () => {
    mockScan.mockResolvedValue(["0", []]);
    expect(await listOnline()).toEqual([]);
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });

  it("listOnline_someOnline_queriesUsersByStrippedIds", async () => {
    mockScan.mockResolvedValue(["0", ["online:u1", "online:u2"]]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u1" }, { id: "u2" }]);
    await listOnline();
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ["u1", "u2"] } } }));
  });
});

describe("getMe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getMe_superAdmin_returnsWildcardPermissionWithoutQueryingPermissions", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.c", fullName: null });
    const me = await getMe(user(["super_admin"]));
    expect(me).toEqual({ id: "u1", email: "a@b.c", fullName: null, roles: ["super_admin"], permissions: ["*"] });
    expect(mockPrisma.permission.findMany).not.toHaveBeenCalled();
  });

  it("getMe_normalUser_returnsPermissionKeysFromRoles", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", email: "a@b.c", fullName: "A" });
    mockPrisma.permission.findMany.mockResolvedValue([{ key: "orders.list" }, { key: "stats.view" }]);
    const me = await getMe(user(["staff"]));
    expect(me.permissions).toEqual(["orders.list", "stats.view"]);
    expect(me.roles).toEqual(["staff"]);
  });
});
