import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";

const prisma = new PrismaClient();

const PERMISSIONS = [
  "orders.list", "orders.read", "orders.create", "orders.update", "orders.update_status",
  "trackings.list", "trackings.create", "trackings.update", "trackings.resolve",
  "shipments.list", "shipments.create", "shipments.upload_doc",
  "warehouse.weigh_jp", "warehouse.weigh_vn",
  "accounting.record_payment", "accounting.refund", "accounting.reconcile",
  "customers.list", "customers.create", "customers.update",
  "users.list", "users.create", "users.update", "roles.assign",
  "media.upload",
  "system.view_audit_log", "system.manage_settings",
];

const ROLES: Record<string, { name: string; perms: string[] | "*" }> = {
  super_admin: { name: "Super Admin", perms: "*" },
  admin: { name: "Admin", perms: PERMISSIONS.filter((p) => !p.startsWith("system.manage")) },
  sale: { name: "Sale", perms: ["orders.list", "orders.read", "orders.create", "orders.update", "customers.list", "customers.create", "customers.update"] },
  accountant: { name: "Kế toán", perms: ["orders.list", "orders.read", "orders.update_status", "accounting.record_payment", "accounting.refund", "accounting.reconcile"] },
  buyer: { name: "NV mua", perms: ["orders.list", "orders.read", "orders.update_status", "trackings.create", "trackings.update", "media.upload"] },
  jp_warehouse: { name: "Kho Nhật", perms: ["orders.list", "trackings.list", "trackings.update", "trackings.resolve", "shipments.list", "shipments.create", "shipments.upload_doc", "warehouse.weigh_jp", "media.upload"] },
  vn_warehouse: { name: "Kho VN", perms: ["orders.list", "trackings.list", "warehouse.weigh_vn"] },
  customs: { name: "Hải quan", perms: ["orders.list", "orders.update_status", "shipments.list"] },
  delivery: { name: "Giao hàng", perms: ["orders.list", "orders.update_status"] },
  viewer: { name: "Viewer", perms: ["orders.list", "orders.read"] },
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
      update: { name: def.name },
      create: { key, name: def.name, isSystem: true },
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

  console.log(`Seed xong. Super admin: ${email} / ${password}`);
}

main().then(() => prisma.$disconnect()).catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
