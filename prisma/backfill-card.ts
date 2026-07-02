import { PrismaClient } from "@prisma/client";

// Backfill: đơn cũ có PT thanh toán = thẻ -> tạo giao dịch "Mua hàng" trừ thẻ.
// Mặc định DRY-RUN (chỉ in tổng). Chạy trừ thật: BACKFILL_APPLY=1
const prisma = new PrismaClient();
const APPLY = process.env.BACKFILL_APPLY === "1";
const AUTO_REF = "auto:order";

function itemJpy(i: any): number {
  return Number(i.unitPriceJpy) * i.qty + (i.shipJpy != null ? Number(i.shipJpy) : 0);
}

async function main() {
  const orders = await prisma.order.findMany({ include: { items: true } });
  const wallets = await prisma.wallet.findMany();
  const byName = new Map(wallets.map((w) => [w.name, w]));

  // đơn đã có giao dịch auto -> bỏ qua (tránh trừ 2 lần)
  const already = new Set(
    (await prisma.walletTxn.findMany({ where: { statementRef: AUTO_REF }, select: { refOrderId: true } }))
      .map((t) => t.refOrderId),
  );

  const totals = new Map<string, { currency: string; charge: number; orders: number; skipNoRate: number }>();
  const plan: { orderId: string; code: string; walletId: string; name: string; charge: number }[] = [];

  for (const o of orders) {
    if (already.has(o.id)) continue;
    const groups = new Map<string, number>();
    for (const i of o.items) {
      const name = i.paymentMethod?.trim();
      if (!name) continue;
      groups.set(name, (groups.get(name) ?? 0) + itemJpy(i));
    }
    for (const [name, jpy] of groups) {
      const w = byName.get(name);
      if (!w) continue; // PT thanh toán không khớp thẻ nào
      const rate = o.exchangeRate != null ? Number(o.exchangeRate) : null;
      const agg = totals.get(name) ?? { currency: w.currency, charge: 0, orders: 0, skipNoRate: 0 };
      let charge: number;
      if (w.currency === "JPY") charge = jpy;
      else if (rate && rate > 0) charge = Math.round(jpy * rate);
      else { agg.skipNoRate++; totals.set(name, agg); continue; }
      if (charge <= 0) continue;
      agg.charge += charge; agg.orders++; totals.set(name, agg);
      plan.push({ orderId: o.id, code: o.code, walletId: w.id, name, charge });
    }
  }

  console.log(`\n=== BACKFILL ${APPLY ? "APPLY (TRU THAT)" : "DRY-RUN (chua tru)"} ===`);
  console.log(`Don xet: ${orders.length} | da co auto (bo qua): ${[...already].filter(Boolean).length}`);
  for (const [name, a] of totals) {
    const unit = a.currency === "JPY" ? "JPY" : "VND";
    console.log(`  ${name} (${a.currency}): -${a.charge.toLocaleString()} ${unit} tu ${a.orders} don${a.skipNoRate ? ` | ${a.skipNoRate} don VND thieu ti gia -> bo qua` : ""}`);
  }
  console.log(`Tong giao dich se tao: ${plan.length}`);

  if (!APPLY) { console.log("\n(DRY-RUN. Chay lai voi BACKFILL_APPLY=1 de tru that.)\n"); return; }

  let done = 0;
  for (const p of plan) {
    await prisma.$transaction([
      prisma.walletTxn.create({ data: {
        walletId: p.walletId, amount: -p.charge, type: "out", category: "Mua hàng",
        note: p.code, refOrderId: p.orderId, statementRef: AUTO_REF,
      } }),
      prisma.wallet.update({ where: { id: p.walletId }, data: { balance: { decrement: p.charge } } }),
    ]);
    done++;
  }
  console.log(`\nDA TAO ${done} giao dich, tru so du xong.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
