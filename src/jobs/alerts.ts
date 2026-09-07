import cron from "node-cron";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { syncPackedFromWarehouse } from "../utils/gsheets.js";
import { logger } from "../logger.js";
import { logWarn, logError } from "../utils/systemLog.js";

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
  if (codes.length) logWarn({ count: codes.length, codes }, "late_orders_no_tracking");
  return codes;
}

export function startJobs(): void {
  // chạy mỗi giờ
  cron.schedule("0 * * * *", () => { scanLateOrders().catch((e) => logError({ err: (e as Error).message }, "alert_job_failed")); });
  scanLateOrders().catch(() => {});
  // quét file kho mỗi 2 phút: mã trùng -> đóng hàng về (cam)
  cron.schedule("*/2 * * * *", () => {
    syncPackedFromWarehouse({ recentDays: 45 }).then((r) => { if (r.updated) logger.info({ updated: r.updated }, "warehouse_pack_synced"); }).catch((e) => logError({ err: (e as Error).message }, "pack_scan_failed"));
  });
}
