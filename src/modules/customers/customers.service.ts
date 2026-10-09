import { v4 as uuid } from "uuid";
import type { Customer } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { paged, type PageParams } from "../../app/http/pagination.js";
import { eventBus } from "../../app/events/EventBus.js";
import { parseSheetId } from "../../integrations/google/googleSheets.client.js";
import { syncCustomerOrders } from "../sheets/customerSheetSync.service.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import * as repo from "./customers.repository.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { computeBalances, emptyBalance, type Balance, type BalanceInputs } from "./customerBalance.js";

export type Actor = { id: string; requestId?: string };
export type { CustomerSortField } from "./customers.repository.js";

export type CustomerInput = {
  name?: string;
  fbZalo?: string | null;
  phone?: string | null;
  address?: string | null;
  note?: string | null;
  sheetUrl?: string | null;
  shipRatePerKg?: number | null;
  shipRateSeaPerKg?: number | null;
  skipVnWeighingDefault?: boolean;
  code?: string;
  payCurrency?: "VND" | "JPY";
  commissionPercentDefault?: number;
};

// Gộp doanh số + công nợ (₫ và ¥) vào từng dòng khách - công thức ở customerBalance.ts (dùng chung mọi báo cáo).
export function withBalances<C extends { id: string }>(rows: C[], inp: BalanceInputs) {
  const bal = computeBalances(inp);
  return rows.map((c) => {
    const b = bal.get(c.id) ?? emptyBalance();
    return { ...c, revenue: b.revenue, debt: b.debt, debtJpy: b.debtJpy };
  });
}

// Công nợ hiện tại (₫ + ¥) của mọi khách có phát sinh - dùng chung cho báo cáo công nợ / báo cáo tháng / MCP.
export async function customerDebts(): Promise<Map<string, Balance>> {
  return computeBalances(await repo.customerMoneyAggregates());
}

// Chỉ nợ ₫ (giữ cho chỗ cũ chỉ cần ₫).
export async function customerVndDebts(): Promise<Map<string, number>> {
  return new Map([...(await customerDebts())].map(([id, b]) => [id, b.debt]));
}

// Không có page -> mảng (contract cũ, tối đa 500). Có page -> { items, pagination }, chỉ gộp số liệu cho trang đó.
// lite (chỉ khi có page) -> items chỉ { id, code, name } cho ô chọn khách, không tính doanh số/công nợ.
export async function listCustomers(page: PageParams | null, lq: repo.CustomerListQuery = {}, opts: { lite?: boolean } = {}) {
  if (!page) {
    const [rows, aggs] = await Promise.all([repo.listCustomers(undefined, lq), repo.customerMoneyAggregates()]);
    return withBalances(rows, aggs);
  }
  if (opts.lite) {
    const [rows, total] = await Promise.all([repo.listCustomerOptions(page, lq), repo.countCustomers(lq.q)]);
    return paged(rows, total, page);
  }
  const [rows, total] = await Promise.all([repo.listCustomers(page, lq), repo.countCustomers(lq.q)]);
  const aggs = await repo.customerMoneyAggregates(rows.map((r) => r.id));
  return paged(withBalances(rows, aggs), total, page);
}

function withSheet(d: CustomerInput) {
  const { sheetUrl, ...rest } = d;
  return sheetUrl !== undefined ? { ...rest, sheetId: parseSheetId(sheetUrl) } : rest;
}

async function assertCodeFree(code: string, exceptId?: string) {
  const dup = await prisma.customer.findFirst({ where: { code: { equals: code, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true } });
  if (dup) throw new AppError("CODE_TAKEN", 409, `Mã khách ${code} đã có`);
}

export async function createCustomer(input: CustomerInput & { name: string }, actor: Actor) {
  if (input.code) await assertCodeFree(input.code);
  const code = input.code ?? await repo.nextCustomerCode();
  const c = await prisma.customer.create({ data: { id: uuid(), ...withSheet(input), code, name: input.name } });
  await logAudit({ actorId: actor.id, targetId: c.id, action: "customer.created", requestId: actor.requestId });
  return c;
}

// Field ảnh hưởng nội dung sheet khách (link sheet, đơn giá ship/kg mặc định, loại tiền).
const SHEET_FIELDS: (keyof CustomerInput)[] = ["sheetUrl", "shipRatePerKg", "shipRateSeaPerKg", "payCurrency"];
// Field đổi cách tính tiền MỌI đơn của khách -> phải tính lại tổng/công nợ từng đơn.
const TOTALS_FIELDS: (keyof CustomerInput)[] = ["shipRatePerKg", "shipRateSeaPerKg", "payCurrency"];

export async function updateCustomer(id: string, input: CustomerInput, actor: Actor): Promise<Customer> {
  if (input.code) await assertCodeFree(input.code, id);
  const c = await prisma.customer.update({ where: { id }, data: withSheet(input) });
  if (TOTALS_FIELDS.some((f) => input[f] !== undefined)) {
    const orders = await prisma.order.findMany({ where: { customerId: id }, select: { id: true } });
    for (const o of orders) await recomputeOrderTotals(o.id);
  }
  await logAudit({ actorId: actor.id, targetId: c.id, action: "customer.updated", requestId: actor.requestId });
  eventBus.publish({ eventName: "customer.updated", actorId: actor.id, entityType: "customer", entityId: c.id, metadata: { fields: Object.keys(input) } });
  if (c.sheetId && SHEET_FIELDS.some((f) => input[f] !== undefined)) await queueCustomerSheetSync(c.id);
  return c;
}

// Đẩy lại toàn bộ đơn + sổ cọc cũ vào sheet khách (dùng khi mới đổi link sheet) - chạy đồng bộ vì FE chờ kết quả.
export async function resyncSheet(id: string) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw new AppError("NOT_FOUND", 404);
  if (!c.sheetId) throw new AppError("NO_SHEET", 400, "Khách chưa có link Sheet");
  await syncCustomerOrders(c.id);
  return { ok: true };
}

// Chặn xóa khi còn đơn / lịch sử cọc / công nợ (FK Restrict) - báo lỗi rõ ràng thay vì để DB từ chối.
export async function deleteCustomer(id: string, actor: Actor) {
  await prisma.$transaction(async (tx) => {
    const refs = await repo.countCustomerRefs(tx, id);
    if (refs.orders > 0) throw new AppError("HAS_ORDERS", 409, "Khách còn đơn, không xóa được");
    if (refs.deposits > 0) throw new AppError("HAS_DEPOSITS", 409, "Khách còn lịch sử cọc, không xóa được");
    if (refs.debts > 0) throw new AppError("HAS_DEBTS", 409, "Khách còn công nợ, không xóa được");
    await tx.customer.delete({ where: { id } });
  });
  await logAudit({ actorId: actor.id, targetId: id, action: "customer.deleted", requestId: actor.requestId });
  return { ok: true };
}
