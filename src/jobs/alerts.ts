import cron from "node-cron";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { syncPackedFromWarehouse } from "../utils/gsheets.js";

// Cảnh báo: đơn quá 7 ngày kể từ thanh toán mà chưa có tracking
export async function scanLateOrders(): Promise<string[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const orders = await prisma.order.findMany({
    where: {
      paidAt: { not: null, lt: sevenDaysAgo },
      status: { notIn: ["completed", "closed", "cancelled"] },
      trackings: { none: {} },
    },
    select: { id: true, code: true, paidAt: true },
  });
  const codes = orders.map((o) => o.code);
  await redis.set("alerts:late_orders", JSON.stringify({ at: new Date().toISOString(), count: orders.length, orders }), "EX", 86400);
  if (codes.length) console.log(`[alert] ${codes.length} đơn quá 7 ngày chưa tracking:`, codes.join(", "));
  return codes;
}

export function startJobs(): void {
  // chạy mỗi giờ
  cron.schedule("0 * * * *", () => { scanLateOrders().catch((e) => console.error("alert job failed", e)); });
  scanLateOrders().catch(() => {});
  // quét file kho mỗi 15 phút: mã trùng -> đóng hàng về (cam)
  cron.schedule("*/15 * * * *", () => {
    syncPackedFromWarehouse().then((r) => { if (r.updated) console.log(`[warehouse] đóng hàng về ${r.updated} tracking`); }).catch((e) => console.error("pack scan failed", e));
  });
}
