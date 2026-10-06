import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    user: { findUnique: vi.fn(), create: vi.fn(), delete: vi.fn() },
    role: { findUnique: vi.fn(), findMany: vi.fn() },
    userRole: { createMany: vi.fn(), deleteMany: vi.fn() },
    accessAudit: { findMany: vi.fn(), count: vi.fn() },
  };
  p.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(p) : Promise.all(arg)));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../middlewares/authorize.js", () => ({ invalidatePermissions: vi.fn() }));
vi.mock("../auth/password.js", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));

import { buildAuditWhere, listAudit, deleteUser, findEditableRole, createUser, assignRoles } from "./admin.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { invalidatePermissions } from "../../middlewares/authorize.js";
import { AppError } from "../../app/errors/AppError.js";

const mp = prisma as any;
const actor = { id: "admin-1" };

describe("buildAuditWhere", () => {
  it("buildAuditWhere_noFilters_returnsEmptyWhere", () => {
    expect(buildAuditWhere({})).toEqual({});
  });

  it("buildAuditWhere_allFilters_mapsActorActionPrefixAndDateRange", () => {
    const from = new Date("2026-01-01");
    const to = new Date("2026-01-31");
    expect(buildAuditWhere({ actor: "u1", action: "auth.", from, to })).toEqual({
      actorId: "u1",
      action: { startsWith: "auth." },
      createdAt: { gte: from, lte: to },
    });
  });

  it("buildAuditWhere_onlyTo_setsUpperBoundOnly", () => {
    const to = new Date("2026-01-31");
    expect(buildAuditWhere({ to })).toEqual({ createdAt: { lte: to } });
  });
});

describe("listAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listAudit_noPage_returnsRowsWithStringIdsAndDoesNotCount", async () => {
    mp.accessAudit.findMany.mockResolvedValue([{ id: 5n, action: "x" }]);
    const r = await listAudit({}, 100, null);
    expect(r).toEqual({ rows: [{ id: "5", action: "x" }] });
    expect(mp.accessAudit.findMany).toHaveBeenCalledWith({ where: {}, orderBy: { createdAt: "desc" }, take: 100 });
    expect(mp.accessAudit.count).not.toHaveBeenCalled();
  });

  it("listAudit_withPage_usesSkipTakeAndReturnsTotal", async () => {
    mp.accessAudit.findMany.mockResolvedValue([{ id: 1n }]);
    mp.accessAudit.count.mockResolvedValue(42);
    const r = await listAudit({ action: "user." }, 100, { page: 2, pageSize: 10, skip: 10, take: 10 });
    expect(r.total).toBe(42);
    expect(mp.accessAudit.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10, where: { action: { startsWith: "user." } } }));
  });
});

describe("deleteUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteUser_self_throws400CannotDeleteSelf", async () => {
    await expect(deleteUser("admin-1", actor)).rejects.toMatchObject({ status: 400, code: "CANNOT_DELETE_SELF" });
  });

  it("deleteUser_targetIsSuperAdmin_throws403ProtectedAndDoesNotDelete", async () => {
    mp.user.findUnique.mockResolvedValue({ id: "u2", roles: [{ role: { key: "super_admin" } }] });
    await expect(deleteUser("u2", actor)).rejects.toMatchObject({ status: 403, code: "PROTECTED" });
    expect(mp.user.delete).not.toHaveBeenCalled();
  });

  it("deleteUser_notFound_throws404", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    await expect(deleteUser("u2", actor)).rejects.toBeInstanceOf(AppError);
  });
});

describe("findEditableRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("findEditableRole_superAdminRole_throws403Protected", async () => {
    mp.role.findUnique.mockResolvedValue({ id: 1, key: "super_admin" });
    const err = await findEditableRole("super_admin").catch((e) => e);
    expect((err as AppError).toBody()).toEqual({ error: "PROTECTED", message: "Không sửa được super_admin" });
  });
});

describe("createUser / assignRoles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createUser_emailExists_throws409EmailExistsWithoutCreating", async () => {
    mp.user.findUnique.mockResolvedValue({ id: "x" });
    await expect(createUser({ email: "a@b.c", password: "123456", roleKeys: [] }, actor)).rejects.toMatchObject({ status: 409, code: "EMAIL_EXISTS" });
    expect(mp.user.create).not.toHaveBeenCalled();
  });

  it("createUser_newEmail_createsUserAndGrantsRolesInOneTransaction", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    mp.user.create.mockResolvedValue({ id: "new", email: "a@b.c" });
    mp.role.findMany.mockResolvedValue([{ id: 3 }]);
    const r = await createUser({ email: "a@b.c", password: "123456", roleKeys: ["sale"] }, actor);
    expect(r).toEqual({ id: "new", email: "a@b.c" });
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(mp.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: "new", roleId: 3, grantedBy: "admin-1" }] });
  });

  it("assignRoles_existingUser_replacesRolesThenInvalidatesPermissionCache", async () => {
    mp.user.findUnique.mockResolvedValue({ id: "u2" });
    mp.role.findMany.mockResolvedValue([]);
    await assignRoles("u2", [], actor);
    expect(mp.userRole.deleteMany).toHaveBeenCalledWith({ where: { userId: "u2" } });
    expect(mp.userRole.createMany).not.toHaveBeenCalled();
    expect(invalidatePermissions).toHaveBeenCalledWith("u2");
  });
});
