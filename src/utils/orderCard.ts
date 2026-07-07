import { prisma } from "../db.js";

type Item = { unitPriceJpy: number | any; qty: number; shipJpy?: number | any | null; paymentMethod?: string | null; purchaseDate?: Date | string | null };
type Client = typeof prisma | any;

const AUTO_REF = "auto:order";

// Tổng tiền JPY thực trả cho 1 món (giá x sl + ship nội địa JP nếu có)
function itemJpy(i: Item): number {
  return Number(i.unitPriceJpy) * i.qty + (i.shipJpy != null ? Number(i.shipJpy) : 0);
}

// Tạo giao dịch "Mua hàng" tự trừ thẻ theo PT thanh toán của từng món.
// Gom món theo tên thẻ + ngày mua (purchaseDate của món, fallback ngày truyền vào) -> ngày trừ thẻ
// khớp đúng ngày mua thật, không phải ngày nhập/sửa đơn (trước đây luôn lấy now() lúc tạo giao dịch).
export async function applyOrderCardCharges(
  db: Client,
  args: { orderId: string; code: string; items: Item[]; exchangeRate?: number | any | null; fallbackDate?: Date },
) {
  const fallback = args.fallbackDate ?? new Date();
  const groups = new Map<string, { name: string; date: Date; jpy: number }>();
  for (const i of args.items) {
    const name = i.paymentMethod?.trim();
    if (!name) continue;
    const date = i.purchaseDate ? new Date(i.purchaseDate) : fallback;
    const key = `${name}|${date.toISOString().slice(0, 10)}`;
    const g = groups.get(key);
    if (g) g.jpy += itemJpy(i);
    else groups.set(key, { name, date, jpy: itemJpy(i) });
  }
  if (!groups.size) return;

  const wallets = await db.wallet.findMany({ where: { name: { in: [...new Set([...groups.values()].map((g) => g.name))] } } });
  const walletByName = new Map<string, any>(wallets.map((w: any) => [w.name, w]));
  const rate = args.exchangeRate != null ? Number(args.exchangeRate) : null;

  for (const g of groups.values()) {
    const w = walletByName.get(g.name);
    if (!w) continue;
    let charge: number;
    if (w.currency === "JPY") charge = g.jpy;
    else if (rate && rate > 0) charge = Math.round(g.jpy * rate);
    else continue; // thẻ VND mà đơn chưa có tỉ giá -> bỏ qua, không đoán
    if (charge <= 0) continue;

    await db.walletTxn.create({
      data: {
        walletId: w.id, amount: -charge, type: "out", category: "Mua hàng",
        note: args.code, refOrderId: args.orderId, statementRef: AUTO_REF, createdAt: g.date,
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
