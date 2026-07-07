import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

const prisma = new PrismaClient();

const PERMISSIONS = [
  "orders.list", "orders.read", "orders.create", "orders.update", "orders.update_status", "orders.delete",
  "trackings.list", "trackings.create", "trackings.update", "trackings.resolve", "trackings.delete",
  "shipments.list", "shipments.upload_doc",
  "warehouse.weigh_jp", "warehouse.weigh_vn",
  "accounting.note_deposit", "accounting.record_payment", "accounting.refund", "accounting.reconcile", "wallets.manage",
  "customers.list", "customers.create", "customers.update", "customers.delete",
  "users.list", "users.create", "users.update", "users.delete",
  "roles.assign", "roles.create", "roles.update", "roles.delete", "permissions.list",
  "media.upload",
  "control.view",
  "companycost.view",
  "system.view_audit_log", "system.manage_settings",
];

const ROLES: Record<string, { name: string; system: boolean; perms: string[] | "*" }> = {
  super_admin: { name: "Super Admin", system: true, perms: "*" },
  admin: { name: "Admin", system: true, perms: PERMISSIONS.filter((p) => !p.startsWith("system.manage")) },
  sale: { name: "Sale", system: false, perms: ["orders.list", "orders.read", "orders.create", "orders.update", "customers.list", "customers.create", "customers.update", "accounting.note_deposit", "trackings.list", "trackings.create", "trackings.update", "trackings.resolve", "trackings.delete", "shipments.list", "shipments.upload_doc", "warehouse.weigh_jp", "warehouse.weigh_vn", "media.upload", "control.view"] },
  accountant: { name: "Kế toán", system: false, perms: ["orders.list", "orders.read", "orders.update_status", "accounting.note_deposit", "accounting.record_payment", "accounting.refund", "accounting.reconcile", "wallets.manage", "companycost.view"] },
  buyer: { name: "NV mua", system: false, perms: ["orders.list", "orders.read", "orders.create", "orders.update", "orders.update_status", "customers.list", "customers.create", "customers.update", "accounting.note_deposit", "trackings.list", "trackings.create", "trackings.update", "trackings.resolve", "trackings.delete", "shipments.list", "shipments.upload_doc", "warehouse.weigh_jp", "warehouse.weigh_vn", "media.upload", "control.view", "companycost.view"] },
  jp_warehouse: { name: "Kho Nhật", system: false, perms: ["orders.list", "trackings.list", "trackings.update", "trackings.resolve", "shipments.list", "shipments.upload_doc", "warehouse.weigh_jp", "media.upload", "control.view"] },
  vn_warehouse: { name: "Kho VN", system: false, perms: ["trackings.list", "warehouse.weigh_vn"] },
  customs: { name: "Hải quan", system: false, perms: ["orders.list", "orders.update_status", "shipments.list"] },
  delivery: { name: "Giao hàng", system: false, perms: ["orders.list", "orders.update_status"] },
  viewer: { name: "Viewer", system: false, perms: ["orders.list", "orders.read"] },
};

async function main() {
  // Permissions
  for (const key of PERMISSIONS) {
    const [resource, action] = key.split(".");
    await prisma.permission.upsert({ where: { key }, update: {}, create: { key, resource, action } });
  }
  const allPerms = await prisma.permission.findMany();
  const permId = (k: string) => allPerms.find((p) => p.key === k)!.id;

  // Roles + role_permissions
  for (const [key, def] of Object.entries(ROLES)) {
    const role = await prisma.role.upsert({
      where: { key },
      update: { name: def.name, isSystem: def.system },
      create: { key, name: def.name, isSystem: def.system },
    });
    const perms = def.perms === "*" ? [] : def.perms; // super_admin bypass ở code
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    for (const pk of perms) {
      await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permId(pk) } });
    }
  }

  // Super admin user
  const email = process.env.ADMIN_EMAIL ?? "admin@orderhn.local";
  const password = process.env.ADMIN_PASSWORD ?? "Admin@12345";
  const superRole = await prisma.role.findUnique({ where: { key: "super_admin" } });
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { id: uuid(), email, passwordHash: await bcrypt.hash(password, 10), fullName: "Super Admin" },
  });
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: user.id, roleId: superRole!.id } },
    update: {},
    create: { userId: user.id, roleId: superRole!.id },
  });

  // Ví mặc định
  for (const name of ["4356 GLOBAL", "Nanaco", "Paypay"]) {
    await prisma.wallet.upsert({ where: { name }, update: {}, create: { id: uuid(), name } });
  }

  // Backfill mã KH cho khách cũ chưa có code
  const noCode = await prisma.customer.findMany({ where: { code: null }, orderBy: { createdAt: "asc" } });
  if (noCode.length) {
    const last = await prisma.customer.findFirst({ where: { code: { startsWith: "KH-" } }, orderBy: { code: "desc" }, select: { code: true } });
    let n = last?.code ? parseInt(last.code.slice(3), 10) || 0 : 0;
    for (const c of noCode) {
      n += 1;
      await prisma.customer.update({ where: { id: c.id }, data: { code: `KH-${String(n).padStart(4, "0")}` } });
    }
    console.log(`Backfill mã KH cho ${noCode.length} khách`);
  }

  console.log(`Seed xong. Super admin: ${email} / ${password}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
