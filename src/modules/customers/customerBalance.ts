// Quy tắc tiền khách dùng chung cho MỌI chỗ tính công nợ (trang Khách, Ví khách, báo cáo, MCP) - sửa 1 chỗ này.
// Khách "VND": nợ ₫ = tổng totalVnd đơn (trừ đơn hủy) - (cọc đã xác nhận amountVnd + thanh toán đơn).
// Khách "JPY": thêm nợ ¥ = tổng dueJpy đơn - cọc JPY đã xác nhận (amountOrig). Cọc ghi ₫ của khách yên trừ vào nợ ₫
// (tiền cân/vận chuyển). Tiền thật của cọc ¥ vẫn vào ví ₫ = amountVnd (yên x tỉ giá lúc chuyển), không ảnh hưởng nợ ¥.

export type PayCurrency = "VND" | "JPY" | string;

// Cọc này trừ vào nợ ¥ (true) hay nợ ₫ (false).
export const depositCreditsJpy = (payCurrency: PayCurrency | null | undefined, depositCurrency: string) =>
  payCurrency === "JPY" && depositCurrency === "JPY";

export type DepositLike = { currency: string; amountVnd: unknown; amountOrig: unknown };
// Giá trị 1 cọc theo đúng sổ nợ của khách.
export function depositCredit(payCurrency: PayCurrency | null | undefined, d: DepositLike): { vnd: number; jpy: number } {
  return depositCreditsJpy(payCurrency, d.currency) ? { vnd: 0, jpy: Number(d.amountOrig ?? 0) } : { vnd: Number(d.amountVnd ?? 0), jpy: 0 };
}

export type Balance = { revenue: number; orderVnd: number; orderJpy: number; paidVnd: number; paidJpy: number; debt: number; debtJpy: number };
export const emptyBalance = (): Balance => ({ revenue: 0, orderVnd: 0, orderJpy: 0, paidVnd: 0, paidJpy: 0, debt: 0, debtJpy: 0 });

export type BalanceInputs = {
  payCurrency: Map<string, string>;
  revenue: { customerId: string; totalVnd: number }[];
  orders: { customerId: string; totalVnd: number; dueJpy: number }[];
  deposits: { customerId: string; currency: string; amountVnd: number; amountOrig: number }[];
  payments: { customerId: string | null | undefined; type: string; amountVnd: number }[];
};

export function computeBalances(inp: BalanceInputs): Map<string, Balance> {
  const out = new Map<string, Balance>();
  const get = (id: string) => { let b = out.get(id); if (!b) { b = emptyBalance(); out.set(id, b); } return b; };
  for (const r of inp.revenue) get(r.customerId).revenue += r.totalVnd;
  for (const o of inp.orders) { const b = get(o.customerId); b.orderVnd += o.totalVnd; b.orderJpy += o.dueJpy; }
  for (const d of inp.deposits) {
    const c = depositCredit(inp.payCurrency.get(d.customerId), d);
    const b = get(d.customerId); b.paidVnd += c.vnd; b.paidJpy += c.jpy;
  }
  for (const p of inp.payments) {
    if (!p.customerId) continue;
    get(p.customerId).paidVnd += p.type === "refund" ? -p.amountVnd : p.amountVnd;
  }
  for (const b of out.values()) { b.debt = b.orderVnd - b.paidVnd; b.debtJpy = b.orderJpy - b.paidJpy; }
  return out;
}
