import type { Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";

type Tx = Prisma.TransactionClient;

export type CustomerSortField = "createdAt" | "name" | "code";
export type CustomerListQuery = { q?: string; sort?: CustomerSortField; dir?: "asc" | "desc" };

// Tìm theo tên / SĐT / mã KH / FB-Zalo (không phân biệt hoa thường).
export function customerListWhere(q?: string): Prisma.CustomerWhereInput | undefined {
  if (!q) return undefined;
  const c = { contains: q, mode: "insensitive" as const };
  return { OR: [{ name: c }, { phone: c }, { code: c }, { fbZalo: c }] };
}

// name/code mặc định A-Z; createdAt mặc định mới nhất trước (như cũ).
const customerOrderBy = (lq: CustomerListQuery): Prisma.CustomerOrderByWithRelationInput | Prisma.CustomerOrderByWithRelationInput[] => {
  if (!lq.sort || lq.sort === "createdAt") return { createdAt: lq.dir ?? "desc" };
  return [{ [lq.sort]: lq.dir ?? "asc" }, { createdAt: "desc" }];
};

// Không phân trang -> tối đa 500 khách mới nhất (contract cũ).
export function listCustomers(page?: { skip: number; take: number }, lq: CustomerListQuery = {}) {
  return prisma.customer.findMany({ where: customerListWhere(lq.q), orderBy: customerOrderBy(lq), skip: page?.skip, take: page?.take ?? 500 });
}

// Bản gọn cho ô chọn khách (search-as-you-type): không gộp doanh số/công nợ.
export function listCustomerOptions(page: { skip: number; take: number }, lq: CustomerListQuery = {}) {
  return prisma.customer.findMany({
    where: customerListWhere(lq.q), orderBy: customerOrderBy(lq), skip: page.skip, take: page.take,
    select: { id: true, code: true, name: true },
  });
}

export const countCustomers = (q?: string) => prisma.customer.count({ where: customerListWhere(q) });

// Số liệu thô để tính doanh số + công nợ theo khách. ids = chỉ lấy cho các khách đó (trang hiện tại);
// không truyền = toàn bộ (hành vi cũ của GET /customers).
export function customerMoneyAggregates(ids?: string[]) {
  const byCustomer = ids ? { customerId: { in: ids } } : {};
  return Promise.all([
    prisma.order.groupBy({ by: ["customerId"], where: byCustomer, _sum: { totalVnd: true } }),
    prisma.order.groupBy({ by: ["customerId"], where: { ...byCustomer, status: { not: "cancelled" } }, _sum: { totalVnd: true } }),
    prisma.debt.groupBy({ by: ["customerId"], where: { ...byCustomer, currency: "JPY" }, _sum: { balance: true } }),
    prisma.customerDeposit.groupBy({ by: ["customerId"], where: { ...byCustomer, confirmed: true }, _sum: { amountVnd: true } }),
    prisma.payment.findMany({
      where: ids ? { order: { customerId: { in: ids } } } : undefined,
      select: { amountVnd: true, type: true, order: { select: { customerId: true } } },
    }),
  ]);
}

// Sinh mã KH-0001 tăng dần
export async function nextCustomerCode(db: Tx | typeof prisma = prisma): Promise<string> {
  const last = await db.customer.findFirst({
    where: { code: { startsWith: "KH-" } },
    orderBy: { code: "desc" },
    select: { code: true },
  });
  const n = last?.code ? parseInt(last.code.slice(3), 10) || 0 : 0;
  return `KH-${String(n + 1).padStart(4, "0")}`;
}

// Dữ liệu còn tham chiếu tới khách (FK Restrict) - phải chặn xóa trước khi DB từ chối.
export async function countCustomerRefs(tx: Tx, customerId: string) {
  const orders = await tx.order.count({ where: { customerId } });
  const deposits = await tx.customerDeposit.count({ where: { customerId } });
  const debts = await tx.debt.count({ where: { customerId } });
  return { orders, deposits, debts };
}
