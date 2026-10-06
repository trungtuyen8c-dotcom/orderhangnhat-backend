// Ghép dòng sao kê <-> giao dịch ví chưa đối soát (M9-2). Hàm thuần.
// Quy tắc: cùng số tiền có dấu (so tới đồng/xu), ngày lệch không quá toleranceDays, 1-1,
// tham lam theo độ lệch ngày nhỏ nhất. Chỉ ĐỀ XUẤT - người dùng duyệt rồi mới ghi.

export const DEFAULT_TOLERANCE_DAYS = 2;
export const MAX_TOLERANCE_DAYS = 31;

export type MatchRow = { rowIndex: number; date: string | null; amount: number | null };
export type MatchTxn = { id: string; amount: number; date: string }; // date = ngày lịch VN YYYY-MM-DD
export type Proposal = { rowIndex: number; txnId: string; dayDiff: number };

const cents = (n: number) => Math.round(n * 100);

export function dayDiff(a: string, b: string): number {
  const toDays = (s: string) => {
    const [y, m, d] = s.split("-").map(Number);
    return Date.UTC(y, m - 1, d) / 86400000;
  };
  return Math.abs(toDays(a) - toDays(b));
}

// YYYY-MM-DD +/- n ngày (dùng giới hạn khung truy vấn giao dịch).
export function shiftDate(s: string, days: number): string {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function proposeMatches(rows: MatchRow[], txns: MatchTxn[], toleranceDays: number): Proposal[] {
  const byAmount = new Map<number, MatchTxn[]>();
  for (const t of txns) {
    const k = cents(t.amount);
    const arr = byAmount.get(k) ?? [];
    arr.push(t);
    byAmount.set(k, arr);
  }
  const pairs: Proposal[] = [];
  for (const r of rows) {
    if (r.date == null || r.amount == null) continue;
    for (const t of byAmount.get(cents(r.amount)) ?? []) {
      const diff = dayDiff(r.date, t.date);
      if (diff <= toleranceDays) pairs.push({ rowIndex: r.rowIndex, txnId: t.id, dayDiff: diff });
    }
  }
  // Ổn định khi bằng độ lệch: dòng sao kê trước, rồi giao dịch theo ngày/id (txns đã sắp theo thời gian).
  const txnOrder = new Map(txns.map((t, i) => [t.id, i]));
  pairs.sort((a, b) => a.dayDiff - b.dayDiff || a.rowIndex - b.rowIndex || txnOrder.get(a.txnId)! - txnOrder.get(b.txnId)!);
  const usedRows = new Set<number>(), usedTxns = new Set<string>();
  const out: Proposal[] = [];
  for (const p of pairs) {
    if (usedRows.has(p.rowIndex) || usedTxns.has(p.txnId)) continue;
    usedRows.add(p.rowIndex);
    usedTxns.add(p.txnId);
    out.push(p);
  }
  return out.sort((a, b) => a.rowIndex - b.rowIndex);
}
