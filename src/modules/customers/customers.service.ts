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
  skipVnWeighingDefault?: boolean;
};

type Aggregates = Awaited<ReturnType<typeof repo.customerMoneyAggregates>>;

// Gộp doanh số (tổng VND các đơn) + công nợ theo khách.
// Công nợ VND = tổng đơn (trừ đơn đã hủy) - (cọc CustomerDeposit đã xác nhận + Payment) - tính giống
// /accounting/customers/:id/ledger. KHÔNG dùng bảng Debt cho phần VND: bảng đó chỉ tạo/cập nhật khi có
// Payment qua flow cũ, không biết đến cọc ghi qua Ví khách (flow hiện tại) -> nếu khách chỉ ghi cọc, Debt
// không có dòng nào, nợ luôn hiện sai là 0.
// Nợ ¥ (đơn định giá thẳng JPY, khách trả thẳng chưa quy đổi) vẫn lấy từ bảng Debt vì ledger không tách khoản này.
export function withBalances<C extends { id: string }>(rows: C[], [revenue, debtOrders, debtJpyAgg, deposits, payments]: Aggregates) {
  const rev = new Map(revenue.map((r) => [r.customerId, Number(r._sum.totalVnd ?? 0)]));
  const orderTotalMap = new Map(debtOrders.map((r) => [r.customerId, Number(r._sum.totalVnd ?? 0)]));
  const debtJpyMap = new Map(debtJpyAgg.map((d) => [d.customerId, Number(d._sum.balance ?? 0)]));
  const paidMap = new Map<string, number>();
  for (const d of deposits) paidMap.set(d.customerId, (paidMap.get(d.customerId) ?? 0) + Number(d._sum.amountVnd ?? 0));
  for (const p of payments) {
    const cid = p.order?.customerId;
    if (!cid) continue;
    const v = p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd);
    paidMap.set(cid, (paidMap.get(cid) ?? 0) + v);
  }
  return rows.map((c) => {
    const orderTotal = orderTotalMap.get(c.id) ?? 0;
    const paidTotal = paidMap.get(c.id) ?? 0;
    return { ...c, revenue: rev.get(c.id) ?? 0, debt: orderTotal - paidTotal, debtJpy: debtJpyMap.get(c.id) ?? 0 };
  });
}

// Công nợ VND hiện tại của mọi khách có phát sinh (cùng công thức withBalances) - dùng chung cho báo cáo công nợ.
export async function customerVndDebts(): Promise<Map<string, number>> {
  const aggs = await repo.customerMoneyAggregates();
  const ids = new Set<string>([...aggs[1].map((r) => r.customerId), ...aggs[3].map((d) => d.customerId)]);
  for (const p of aggs[4]) if (p.order?.customerId) ids.add(p.order.customerId);
  return new Map(withBalances([...ids].map((id) => ({ id })), aggs).map((r) => [r.id, r.debt]));
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

export async function createCustomer(input: CustomerInput & { name: string }, actor: Actor) {
  const code = await repo.nextCustomerCode();
  const c = await prisma.customer.create({ data: { id: uuid(), code, ...withSheet(input), name: input.name } });
  await logAudit({ actorId: actor.id, targetId: c.id, action: "customer.created", requestId: actor.requestId });
  return c;
}

// Field ảnh hưởng nội dung sheet khách (link sheet, đơn giá ship/kg mặc định).
const SHEET_FIELDS: (keyof CustomerInput)[] = ["sheetUrl", "shipRatePerKg"];

export async function updateCustomer(id: string, input: CustomerInput, actor: Actor): Promise<Customer> {
  const c = await prisma.customer.update({ where: { id }, data: withSheet(input) });
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
