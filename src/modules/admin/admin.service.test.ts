import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    role: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    userRole: { createMany: vi.fn(), deleteMany: vi.fn(), findMany: vi.fn() },
    permission: { findMany: vi.fn() },
    rolePermission: { deleteMany: vi.fn(), createMany: vi.fn() },
    accessAudit: { findMany: vi.fn(), count: vi.fn() },
  };
  p.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(p) : Promise.all(arg)));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../middlewares/authorize.js", () => ({ invalidatePermissions: vi.fn() }));
vi.mock("../auth/password.js", () => ({ hashPassword: vi.fn().mockResolvedValue("hashed") }));

import {
  buildAuditWhere, listAudit, deleteUser, findEditableRole, createUser, assignRoles,
  listUsers, updateUser, listRoles, createRole, updateRole, deleteRole,
} from "./admin.service.js";
import { logAudit } from "../../app/audit.js";
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

describe("listUsers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listUsers_userWithTotp_flattensRoleKeysAndExposesTwoFactorFlagOnly", async () => {
    mp.user.findMany.mockResolvedValue([{
      id: "u1", email: "a@b.c", fullName: null, isActive: true, totpEnabledAt: new Date("2026-01-01"),
      roles: [{ role: { key: "sale", name: "Sale" } }, { role: { key: "buyer", name: "Buyer" } }],
    }]);
    const [u] = await listUsers();
    expect(u).toEqual({ id: "u1", email: "a@b.c", fullName: null, isActive: true, twoFactorEnabled: true, roles: ["sale", "buyer"] });
  });

  it("listUsers_userWithoutTotp_twoFactorDisabled", async () => {
    mp.user.findMany.mockResolvedValue([{ id: "u1", email: "a@b.c", fullName: null, isActive: true, totpEnabledAt: null, roles: [] }]);
    const [u] = await listUsers();
    expect(u.twoFactorEnabled).toBe(false);
  });
});

describe("createUser (gaps)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createUser_newEmail_storesHashedPasswordNotPlaintext", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    mp.user.create.mockResolvedValue({ id: "new", email: "a@b.c" });
    mp.role.findMany.mockResolvedValue([]);
    await createUser({ email: "a@b.c", password: "123456", fullName: "A", roleKeys: [] }, actor);
    expect(mp.user.create.mock.calls[0][0].data).toMatchObject({ email: "a@b.c", passwordHash: "hashed", fullName: "A" });
    expect(mp.user.create.mock.calls[0][0].data).not.toHaveProperty("password");
  });

  it("createUser_unknownRoleKeys_grantsNothing", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    mp.user.create.mockResolvedValue({ id: "new", email: "a@b.c" });
    mp.role.findMany.mockResolvedValue([]);
    await createUser({ email: "a@b.c", password: "123456", roleKeys: ["ghost"] }, actor);
    expect(mp.userRole.createMany).not.toHaveBeenCalled();
  });

  it("createUser_success_auditsUserCreatedWithRoles", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    mp.user.create.mockResolvedValue({ id: "new", email: "a@b.c" });
    mp.role.findMany.mockResolvedValue([]);
    await createUser({ email: "a@b.c", password: "123456", roleKeys: ["sale"] }, actor);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actorId: "admin-1", targetId: "new", action: "user.created", metadata: { roles: ["sale"] } }));
  });
});

describe("updateUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updateUser_deactivate_invalidatesPermissionCache", async () => {
    mp.user.update.mockResolvedValue({ id: "u2" });
    await updateUser("u2", { isActive: false }, actor);
    expect(invalidatePermissions).toHaveBeenCalledWith("u2");
  });

  it.each([
    ["activate", { isActive: true }],
    ["renameOnly", { fullName: "B" }],
  ])("updateUser_%s_keepsPermissionCache", async (_name, data) => {
    mp.user.update.mockResolvedValue({ id: "u2" });
    await updateUser("u2", data, actor);
    expect(invalidatePermissions).not.toHaveBeenCalled();
  });

  it("updateUser_success_auditsChangedFieldsAndReturnsId", async () => {
    mp.user.update.mockResolvedValue({ id: "u2", email: "x" });
    const r = await updateUser("u2", { fullName: "B" }, actor);
    expect(r).toEqual({ id: "u2" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "u2", action: "user.updated", metadata: { fullName: "B" } }));
  });
});

describe("deleteUser (gaps)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteUser_regularUser_deletesAndAudits", async () => {
    mp.user.findUnique.mockResolvedValue({ id: "u2", roles: [{ role: { key: "sale" } }] });
    await deleteUser("u2", actor);
    expect(mp.user.delete).toHaveBeenCalledWith({ where: { id: "u2" } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "u2", action: "user.deleted" }));
  });

  it("deleteUser_self_doesNotLookUpOrDelete", async () => {
    await deleteUser("admin-1", actor).catch(() => undefined);
    expect(mp.user.delete).not.toHaveBeenCalled();
  });
});

describe("assignRoles (gaps)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("assignRoles_unknownUser_throws404WithoutTouchingRoles", async () => {
    mp.user.findUnique.mockResolvedValue(null);
    await expect(assignRoles("u9", ["sale"], actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(mp.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it("assignRoles_knownRoles_grantsByActorAndAudits", async () => {
    mp.user.findUnique.mockResolvedValue({ id: "u2" });
    mp.role.findMany.mockResolvedValue([{ id: 4 }, { id: 5 }]);
    await assignRoles("u2", ["sale", "buyer"], actor);
    expect(mp.userRole.createMany).toHaveBeenCalledWith({ data: [{ userId: "u2", roleId: 4, grantedBy: "admin-1" }, { userId: "u2", roleId: 5, grantedBy: "admin-1" }] });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "u2", action: "role.assigned", metadata: { roles: ["sale", "buyer"] } }));
  });
});

describe("listRoles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listRoles_givenRoles_flattensPermissionKeys", async () => {
    mp.role.findMany.mockResolvedValue([{ id: 1, key: "sale", name: "Sale", isSystem: true, permissions: [{ permission: { key: "orders.read" } }] }]);
    expect(await listRoles()).toEqual([{ id: 1, key: "sale", name: "Sale", isSystem: true, permissions: ["orders.read"] }]);
  });
});

describe("createRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createRole_keyExists_throws409RoleExists", async () => {
    mp.role.findUnique.mockResolvedValue({ id: 1 });
    await expect(createRole({ key: "sale", name: "S", permissionKeys: [] }, actor)).rejects.toMatchObject({ status: 409, code: "ROLE_EXISTS" });
    expect(mp.role.create).not.toHaveBeenCalled();
  });

  it("createRole_newKey_createsNonSystemRoleWithPermissions", async () => {
    mp.role.findUnique.mockResolvedValue(null);
    mp.role.create.mockResolvedValue({ id: 7, key: "qc" });
    mp.permission.findMany.mockResolvedValue([{ id: 11 }]);
    await createRole({ key: "qc", name: "QC", permissionKeys: ["orders.read"] }, actor);
    expect(mp.role.create).toHaveBeenCalledWith({ data: { key: "qc", name: "QC", isSystem: false } });
    expect(mp.rolePermission.createMany).toHaveBeenCalledWith({ data: [{ roleId: 7, permissionId: 11 }] });
  });

  it("createRole_success_auditsRoleCreated", async () => {
    mp.role.findUnique.mockResolvedValue(null);
    mp.role.create.mockResolvedValue({ id: 7, key: "qc" });
    mp.permission.findMany.mockResolvedValue([]);
    await createRole({ key: "qc", name: "QC", permissionKeys: [] }, actor);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "role.created", metadata: { key: "qc" } }));
  });
});

describe("findEditableRole (gaps)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("findEditableRole_unknownKey_throws404", async () => {
    mp.role.findUnique.mockResolvedValue(null);
    await expect(findEditableRole("ghost")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("findEditableRole_regularRole_returnsRole", async () => {
    mp.role.findUnique.mockResolvedValue({ id: 2, key: "sale" });
    expect(await findEditableRole("sale")).toEqual({ id: 2, key: "sale" });
  });
});

describe("updateRole", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mp.userRole.findMany.mockResolvedValue([]);
  });

  it("updateRole_nameOnly_renamesWithoutTouchingPermissions", async () => {
    await updateRole({ id: 2, key: "sale" }, { name: "Bán hàng" }, actor);
    expect(mp.role.update).toHaveBeenCalledWith({ where: { id: 2 }, data: { name: "Bán hàng" } });
    expect(mp.rolePermission.deleteMany).not.toHaveBeenCalled();
  });

  it("updateRole_emptyPermissionList_clearsAllPermissions", async () => {
    mp.permission.findMany.mockResolvedValue([]);
    await updateRole({ id: 2, key: "sale" }, { permissionKeys: [] }, actor);
    expect(mp.rolePermission.deleteMany).toHaveBeenCalledWith({ where: { roleId: 2 } });
    expect(mp.rolePermission.createMany).not.toHaveBeenCalled();
  });

  it("updateRole_roleHeldByUsers_invalidatesEachUsersPermissionCache", async () => {
    mp.userRole.findMany.mockResolvedValue([{ userId: "a" }, { userId: "b" }]);
    await updateRole({ id: 2, key: "sale" }, { name: "X" }, actor);
    expect(invalidatePermissions).toHaveBeenCalledWith("a");
    expect(invalidatePermissions).toHaveBeenCalledWith("b");
  });

  it("updateRole_success_auditsWithAfterInput", async () => {
    await updateRole({ id: 2, key: "sale" }, { name: "X" }, actor);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "role.updated", metadata: { key: "sale" }, after: { name: "X" } }));
  });
});

describe("deleteRole", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteRole_unknownKey_throws404", async () => {
    mp.role.findUnique.mockResolvedValue(null);
    await expect(deleteRole("ghost", actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("deleteRole_systemRole_throws403ProtectedWithoutDeleting", async () => {
    mp.role.findUnique.mockResolvedValue({ id: 1, key: "sale", isSystem: true });
    await expect(deleteRole("sale", actor)).rejects.toMatchObject({ status: 403, code: "PROTECTED" });
    expect(mp.role.delete).not.toHaveBeenCalled();
  });

  it("deleteRole_customRole_deletesAndAudits", async () => {
    mp.role.findUnique.mockResolvedValue({ id: 7, key: "qc", isSystem: false });
    await deleteRole("qc", actor);
    expect(mp.role.delete).toHaveBeenCalledWith({ where: { id: 7 } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "role.deleted", metadata: { key: "qc" } }));
  });
});
