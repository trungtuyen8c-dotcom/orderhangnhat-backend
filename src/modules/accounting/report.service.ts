import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";
import { vnDayEnd, vnDayStart, vnMonthKey } from "../../app/vnTime.js";

// Báo cáo chỉ đọc. Mốc ngày/tháng luôn theo giờ VN (vnMonthKey / vnDayStart / vnDayEnd).

const monthOr = (m: unknown) => (typeof m === "string" && /^\d{4}-\d{2}$/.test(m) ? m : vnMonthKey(new Date()));

// Công nợ gộp theo khách: mỗi khách còn nợ bao nhiêu
export async function debtsByCustomer() {
  // Bảng này hiển thị số ₫ - chỉ gộp nợ VND, nợ ¥ (khách trả thẳng, chưa có tỉ giá) không trộn vào đây
  const grouped = await prisma.debt.groupBy({
    by: ["customerId"],
    where: { currency: "VND" },
    _sum: { balance: true },
    _max: { updatedAt: true },
  });
  const ids = grouped.map((g) => g.customerId);
  const customers = await prisma.customer.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, phone: true },
  });
  const map = new Map(customers.map((c) => [c.id, c]));
  return grouped
    .map((g) => ({
      customerId: g.customerId,
      code: g.customerId.slice(0, 8).toUpperCase(),
      name: map.get(g.customerId)?.name ?? "?",
      phone: map.get(g.customerId)?.phone ?? null,
      balance: Number(g._sum.balance ?? 0),
      updatedAt: g._max.updatedAt,
    }))
    .filter((r) => r.balance !== 0)
    .sort((a, b) => b.balance - a.balance);
}

// ===== Ví khách: cọc cục + đối soát theo tháng =====
// Còn nợ khách = tổng đơn (VND) - (cọc cục + thanh toán theo đơn).
export async function customerLedger(customerId: string) {
  const orders = await prisma.order.findMany({
    where: { customerId, status: { not: "cancelled" } },
    select: { totalVnd: true, createdAt: true },
  });
  const deposits = await prisma.customerDeposit.findMany({ where: { customerId }, orderBy: { paidAt: "desc" } });
  const payments = await prisma.payment.findMany({ where: { order: { customerId } }, select: { amountVnd: true, type: true, createdAt: true } });

  // Chỉ cọc đã xác nhận (tiền thật vào) mới trừ công nợ. Cọc chờ -> pendingTotal.
  const confirmed = deposits.filter((d) => d.confirmed);
  const orderTotal = orders.reduce((s, o) => s + Number(o.totalVnd ?? 0), 0);
  const depositTotal = confirmed.reduce((s, d) => s + Number(d.amountVnd), 0);
  const pendingTotal = deposits.filter((d) => !d.confirmed).reduce((s, d) => s + Number(d.amountVnd), 0);
  const paymentTotal = payments.reduce((s, p) => s + (p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd)), 0);
  const paidTotal = depositTotal + paymentTotal;
  const debt = orderTotal - paidTotal;

  const mk = vnMonthKey;
  const months = new Map<string, { order: number; paid: number }>();
  const bump = (k: string, f: "order" | "paid", v: number) => { const m = months.get(k) ?? { order: 0, paid: 0 }; m[f] += v; months.set(k, m); };
  for (const o of orders) bump(mk(o.createdAt), "order", Number(o.totalVnd ?? 0));
  for (const d of confirmed) bump(mk(d.paidAt), "paid", Number(d.amountVnd));
  for (const p of payments) bump(mk(p.createdAt), "paid", p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd));

  let run = 0;
  const byMonth = [...months.keys()].sort().map((month) => {
    const m = months.get(month)!;
    run += m.paid - m.order;
    return { month, order: m.order, paid: m.paid, balance: run };
  });
  return { orderTotal, depositTotal, pendingTotal, paymentTotal, paidTotal, debt, deposits, byMonth };
}

// Bảng tổng quan: mỗi khách mua bao nhiêu / cọc (đã xác nhận) / còn nợ
export async function customerSummary() {
  const [orderAgg, depAgg, payments, customers] = await Promise.all([
    prisma.order.groupBy({ by: ["customerId"], where: { status: { not: "cancelled" } }, _sum: { totalVnd: true } }),
    prisma.customerDeposit.groupBy({ by: ["customerId"], where: { confirmed: true }, _sum: { amountVnd: true } }),
    prisma.payment.findMany({ select: { amountVnd: true, type: true, order: { select: { customerId: true } } } }),
    prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
  ]);
  const cmap = new Map(customers.map((c) => [c.id, c]));
  const mua = new Map<string, number>();
  for (const o of orderAgg) mua.set(o.customerId, Number(o._sum.totalVnd ?? 0));
  const coc = new Map<string, number>();
  for (const d of depAgg) coc.set(d.customerId, Number(d._sum.amountVnd ?? 0));
  for (const p of payments) {
    const cid = p.order?.customerId; if (!cid) continue;
    coc.set(cid, (coc.get(cid) ?? 0) + (p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd)));
  }
  const ids = new Set<string>([...mua.keys(), ...coc.keys()]);
  return [...ids].map((id) => {
    const m = mua.get(id) ?? 0, c = coc.get(id) ?? 0;
    return { customerId: id, name: cmap.get(id)?.name ?? "?", code: cmap.get(id)?.code ?? null, mua: m, coc: c, no: m - c };
  }).sort((a, b) => b.no - a.no);
}

// Báo cáo theo tháng: tổng cân, tổng tiền mua, đã trả - từng khách + tổng. Kèm công nợ hiện tại (luỹ kế).
// Tiền mua theo createdAt của đơn; cân theo packedAt của tracking (cân VN ưu tiên, chưa có dùng cân JP); đã trả = cọc xác nhận + thanh toán đơn trong tháng.
export async function monthlyReport(monthQ: unknown) {
  const mk = vnMonthKey;
  const month = monthOr(monthQ);

  const [orders, trks, deposits, payments, customers, debtAgg] = await Promise.all([
    prisma.order.findMany({ where: { status: { not: "cancelled" } }, select: { customerId: true, totalVnd: true, createdAt: true } }),
    prisma.tracking.findMany({ where: { packedAt: { not: null }, orderId: { not: null } }, select: { jpWeightKg: true, vnWeightKg: true, packedAt: true, order: { select: { customerId: true } } } }),
    prisma.customerDeposit.findMany({ where: { confirmed: true }, select: { customerId: true, amountVnd: true, paidAt: true } }),
    prisma.payment.findMany({ select: { amountVnd: true, type: true, createdAt: true, order: { select: { customerId: true } } } }),
    prisma.customer.findMany({ select: { id: true, name: true, code: true } }),
    prisma.debt.groupBy({ by: ["customerId"], where: { currency: "VND" }, _sum: { balance: true } }),
  ]);

  const cmap = new Map(customers.map((c) => [c.id, c]));
  type Row = { customerId: string; name: string; code: string | null; canKg: number; mua: number; traTrongThang: number; congNo: number };
  const rows = new Map<string, Row>();
  const get = (id: string): Row => {
    let r = rows.get(id);
    if (!r) { r = { customerId: id, name: cmap.get(id)?.name ?? "?", code: cmap.get(id)?.code ?? null, canKg: 0, mua: 0, traTrongThang: 0, congNo: 0 }; rows.set(id, r); }
    return r;
  };
  for (const o of orders) if (mk(o.createdAt) === month) get(o.customerId).mua += Number(o.totalVnd ?? 0);
  for (const t of trks) { const cid = t.order?.customerId; if (cid && t.packedAt && mk(t.packedAt) === month) get(cid).canKg += t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0); }
  for (const d of deposits) if (mk(d.paidAt) === month) get(d.customerId).traTrongThang += Number(d.amountVnd);
  for (const p of payments) { const cid = p.order?.customerId; if (cid && mk(p.createdAt) === month) get(cid).traTrongThang += p.type === "refund" ? -Number(p.amountVnd) : Number(p.amountVnd); }
  for (const g of debtAgg) { const bal = Number(g._sum.balance ?? 0); if (bal !== 0) get(g.customerId).congNo = bal; }

  const list = [...rows.values()].filter((r) => r.canKg || r.mua || r.traTrongThang || r.congNo).sort((a, b) => b.mua - a.mua);
  const totals = list.reduce((s, r) => ({ canKg: s.canKg + r.canKg, mua: s.mua + r.mua, traTrongThang: s.traTrongThang + r.traTrongThang, congNo: s.congNo + r.congNo }), { canKg: 0, mua: 0, traTrongThang: 0, congNo: 0 });
  return { month, rows: list, totals };
}

// Báo cáo chi phí phát sinh theo tháng (theo incurredAt)
export async function expensesMonthly(monthQ: unknown) {
  const mk = vnMonthKey;
  const month = monthOr(monthQ);
  const all = await prisma.expense.findMany({ orderBy: { incurredAt: "desc" } });
  const rows = all.filter((e) => mk(e.incurredAt) === month);
  const orderIds = [...new Set(rows.map((r) => r.orderId).filter(Boolean) as string[])];
  const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, code: true, customer: { select: { name: true } } } });
  const omap = new Map(orders.map((o) => [o.id, o]));
  const total = rows.reduce((s, r) => s + Number(r.amountVnd), 0);
  const compensation = rows.filter((r) => r.kind === "compensation").reduce((s, r) => s + Number(r.amountVnd), 0);
  return {
    month, total, compensation, other: total - compensation,
    rows: rows.map((r) => ({
      id: r.id, kind: r.kind, amountVnd: Number(r.amountVnd), currency: r.currency, amountOrig: Number(r.amountOrig),
      note: r.note, incurredAt: r.incurredAt,
      orderCode: r.orderId ? omap.get(r.orderId)?.code ?? null : null,
      customerName: r.orderId ? omap.get(r.orderId)?.customer?.name ?? null : null,
    })),
  };
}

// Bảng đối soát theo từng ngày trong tháng: bám mốc wallet.balance hiện tại (số đúng, kể cả có số dư
// ban đầu nhập tay lúc tạo ví không có dòng sổ tương ứng) rồi lùi theo giao dịch, KHÔNG cộng dồn từ 0.
export async function walletDailySummary(walletId: string, monthQ: unknown) {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) throw new AppError("WALLET_NOT_FOUND", 404);

  const monthStr = String(monthQ ?? "");
  const month = /^\d{4}-\d{2}$/.test(monthStr) ? monthStr : vnMonthKey(new Date());
  const [year, monIdx] = month.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const daysInMonth = new Date(Date.UTC(year, monIdx, 0)).getUTCDate();
  const monthEnd = vnDayEnd(`${year}-${pad(monIdx)}-${pad(daysInMonth)}`);

  const [txns, actuals] = await Promise.all([
    prisma.walletTxn.findMany({ where: { walletId: wallet.id }, orderBy: { createdAt: "asc" } }),
    prisma.walletDailyActual.findMany({ where: { walletId: wallet.id, date: { gte: vnDayStart(`${year}-${pad(monIdx)}-01`), lte: monthEnd } } }),
  ]);
  const current = Number(wallet.balance);
  const actualByDay = new Map(actuals.map((a) => [a.date.toISOString().slice(0, 10), Number(a.actualBalance)]));

  let afterCursor = 0;
  for (const t of txns) if (t.createdAt > monthEnd) afterCursor += Number(t.amount);

  const days: { date: string; opening: number; closing: number; actual: number | null; diff: number | null }[] = [];
  for (let d = daysInMonth; d >= 1; d--) {
    const dateKey = `${year}-${pad(monIdx)}-${pad(d)}`;
    const dayStart = vnDayStart(dateKey);
    const dayEnd = vnDayEnd(dateKey);
    let sameDay = 0;
    for (const t of txns) if (t.createdAt >= dayStart && t.createdAt <= dayEnd) sameDay += Number(t.amount);
    const closing = current - afterCursor;
    const opening = closing - sameDay;
    afterCursor += sameDay;

    const actual = actualByDay.has(dateKey) ? actualByDay.get(dateKey)! : null;
    days.push({ date: dateKey, opening, closing, actual, diff: actual == null ? null : actual - closing });
  }
  days.reverse();

  return { walletId: wallet.id, name: wallet.name, currency: wallet.currency, month, days };
}

// Đối soát: liệt kê giao dịch chưa đối soát theo ví
export function unreconciledTxns() {
  return prisma.walletTxn.findMany({ where: { reconciled: false }, orderBy: { createdAt: "desc" }, take: 300, include: { wallet: { select: { name: true } } } });
}

export type StatementQuery = { walletId: string | null; from?: string; to?: string; customer?: string; tracking?: string; q?: string; onlyPending?: boolean };

// Sao kê 1 ví: số dư lũy kế (残高) + lọc theo ngày / khách / tracking / từ khóa
export async function statement(sq: StatementQuery) {
  const walletId = sq.walletId;
  if (!walletId) return { rows: [], balance: 0 };

  const from = sq.from ? vnDayStart(sq.from) : null;
  const to = sq.to ? vnDayEnd(sq.to) : null;
  const customerQ = (sq.customer ?? "").trim().toLowerCase();
  const trackingQ = (sq.tracking ?? "").trim().toLowerCase();
  const q = (sq.q ?? "").trim().toLowerCase();
  const onlyPending = !!sq.onlyPending;

  const txns = await prisma.walletTxn.findMany({ where: { walletId }, orderBy: { createdAt: "asc" } });

  const orderIds = [...new Set(txns.map((t) => t.refOrderId).filter(Boolean))] as string[];
  const depositIds = [...new Set(txns.map((t) => t.refDepositId).filter(Boolean))] as string[];
  const [orders, deposits] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, code: true, fixRequest: true, customer: { select: { name: true, phone: true } }, trackings: { select: { code: true, vnTrackingCode: true } } },
        })
      : Promise.resolve([]),
    depositIds.length
      ? prisma.customerDeposit.findMany({ where: { id: { in: depositIds } }, select: { id: true, customerId: true, fixRequest: true } })
      : Promise.resolve([]),
  ]);
  const depCustIds = [...new Set(deposits.map((d) => d.customerId))];
  const depCustomers = depCustIds.length
    ? await prisma.customer.findMany({ where: { id: { in: depCustIds } }, select: { id: true, name: true, phone: true } })
    : [];
  const depCustMap = new Map(depCustomers.map((c) => [c.id, c]));
  const omap = new Map(orders.map((o) => [o.id, o]));
  const dmap = new Map(deposits.map((d) => [d.id, { ...d, customer: depCustMap.get(d.customerId) }]));

  let bal = 0;
  const enriched = txns.map((t) => {
    bal += Number(t.amount);
    const o = t.refOrderId ? omap.get(t.refOrderId) : undefined;
    const d = t.refDepositId ? dmap.get(t.refDepositId) : undefined;
    const trackings = (o?.trackings.flatMap((tr) => [tr.code, tr.vnTrackingCode]) ?? []).filter((x): x is string => !!x);
    return {
      id: t.id,
      date: t.createdAt,
      amount: Number(t.amount),
      type: t.type,
      category: t.category ?? t.type,
      note: t.note ?? t.statementRef,
      reconciled: t.reconciled,
      statementRef: t.statementRef,
      orderId: t.refOrderId ?? null,
      orderCode: o?.code ?? null,
      depositId: t.refDepositId ?? null,
      fixRequest: o?.fixRequest ?? d?.fixRequest ?? null,
      customer: o?.customer?.name ?? d?.customer?.name ?? null,
      phone: o?.customer?.phone ?? d?.customer?.phone ?? null,
      trackings,
      balance: bal,
    };
  });

  let rows = enriched;
  if (from) rows = rows.filter((r) => r.date >= from);
  if (to) rows = rows.filter((r) => r.date <= to);
  if (customerQ) rows = rows.filter((r) => (r.customer ?? "").toLowerCase().includes(customerQ));
  if (trackingQ) rows = rows.filter((r) => r.trackings.some((c) => c.toLowerCase().includes(trackingQ)));
  if (q) rows = rows.filter((r) => [r.orderCode, r.customer, r.type, ...r.trackings].some((x) => (x ?? "").toLowerCase().includes(q)));
  if (onlyPending) rows = rows.filter((r) => !r.reconciled);

  rows.reverse();
  return { rows, balance: bal };
}
