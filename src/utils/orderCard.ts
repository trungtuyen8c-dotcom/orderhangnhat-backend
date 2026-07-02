import { prisma } from "../db.js";

type Item = { unitPriceJpy: number | any; qty: number; shipJpy?: number | any | null; paymentMethod?: string | null };
type Client = typeof prisma | any;

const AUTO_REF = "auto:order";

// Tổng tiền JPY thực trả cho 1 món (giá x sl + ship nội địa JP nếu có)
function itemJpy(i: Item): number {
  return Number(i.unitPriceJpy) * i.qty + (i.shipJpy != null ? Number(i.shipJpy) : 0);
}

// Tạo giao dịch "Mua hàng" tự trừ thẻ theo PT thanh toán của từng món.
// Gom món theo tên thẻ; thẻ JPY trừ thẳng JPY, thẻ VND quy đổi theo tỉ giá đơn.
export async function applyOrderCardCharges(
  db: Client,
  args: { orderId: string; code: string; items: Item[]; exchangeRate?: number | any | null },
) {
  const groups = new Map<string, number>();
  for (const i of args.items) {
    const name = i.paymentMethod?.trim();
    if (!name) continue;
    groups.set(name, (groups.get(name) ?? 0) + itemJpy(i));
  }
  if (!groups.size) return;

  const wallets = await db.wallet.findMany({ where: { name: { in: [...groups.keys()] } } });
  const rate = args.exchangeRate != null ? Number(args.exchangeRate) : null;

  for (const w of wallets) {
    const jpy = groups.get(w.name)!;
    let charge: number;
    if (w.currency === "JPY") charge = jpy;
    else if (rate && rate > 0) charge = Math.round(jpy * rate);
    else continue; // thẻ VND mà đơn chưa có tỉ giá -> bỏ qua, không đoán
    if (charge <= 0) continue;

    await db.walletTxn.create({
      data: {
        walletId: w.id, amount: -charge, type: "out", category: "Mua hàng",
        note: args.code, refOrderId: args.orderId, statementRef: AUTO_REF,
      },
    });
    await db.wallet.update({ where: { id: w.id }, data: { balance: { decrement: charge } } });
  }
}

// Hoàn lại số dư + xóa các giao dịch "Mua hàng" auto của đơn.
export async function reverseOrderCardCharges(db: Client, orderId: string) {
  const txns = await db.walletTxn.findMany({ where: { refOrderId: orderId, statementRef: AUTO_REF } });
  for (const t of txns) {
    await db.wallet.update({ where: { id: t.walletId }, data: { balance: { increment: -Number(t.amount) } } });
  }
  if (txns.length) await db.walletTxn.deleteMany({ where: { refOrderId: orderId, statementRef: AUTO_REF } });
}
