import type { JobsOptions } from "bullmq";
import { prisma } from "../../infrastructure/prisma.js";
import { enqueue, registerJob, type JobName } from "../../jobs/queues.js";
import { syncCustomerOrders } from "./customerSheetSync.service.js";
import { removeTrackingRow, syncTracking } from "./trackingSheetSync.service.js";
import { clearWarehouseRow, syncPackedFromWarehouse } from "./warehouseSheetSync.service.js";
import { syncPackedOne } from "./warehousePackedOne.service.js";

// Payload job "sheet.sync.warehouse" (1 job name cho mọi việc ghi file kho + sheet Tracking chung).
export type WarehouseSheetJob =
  | { action: "full"; recentDays?: number }
  | { action: "one"; code: string; tab?: string; row?: number; bill?: string; thung?: string }
  | { action: "clearRow"; packedAt: string; row: number }
  | { action: "trackingRow"; trackingId: string }
  | { action: "removeTrackingRow"; trackingId: string };

async function handleWarehouseJob(d: WarehouseSheetJob): Promise<unknown> {
  switch (d.action) {
    case "full": return syncPackedFromWarehouse(d.recentDays ? { recentDays: d.recentDays } : undefined);
    case "one": return syncPackedOne(d.code, d.tab, d.row, d.bill, d.thung);
    case "clearRow": return clearWarehouseRow(new Date(d.packedAt), d.row);
    case "trackingRow": {
      // Đọc lại DB lúc chạy -> luôn ghi trạng thái mới nhất, dù job bị gộp.
      const t = await prisma.tracking.findUnique({ where: { id: d.trackingId } });
      if (t) await syncTracking(t);
      return;
    }
    case "removeTrackingRow": return removeTrackingRow(d.trackingId);
  }
}

// Sheet khách chứa mọi đơn của khách -> đổi 1 đơn cũng sync cả khách (queueCustomerSheetSync), không có job theo đơn.
registerJob("sheet.sync.customer", (d: { customerId: string }) => syncCustomerOrders(d.customerId));
// Sổ cọc/thanh toán nằm trong file sheet của khách -> cùng 1 lượt sync khách.
registerJob("sheet.sync.accounting", (d: { customerId: string }) => syncCustomerOrders(d.customerId));
registerJob("sheet.sync.warehouse", (d: WarehouseSheetJob) => handleWarehouseJob(d));

// Gộp job trùng bằng BullMQ deduplication (không dùng jobId cố định: jobId của job đã completed/failed còn lưu
// trong Redis sẽ chặn add lại suốt thời gian giữ). keepLastIfActive: job đang chạy mà có yêu cầu mới -> chạy thêm
// 1 lượt sau khi xong, tránh mất thay đổi xảy ra trong lúc đang sync.
function dedupe(id: string): JobsOptions {
  return { deduplication: { id, keepLastIfActive: true } };
}
const enqueueDeduped = (name: JobName, data: Record<string, unknown>, key: string) => enqueue(name, data, dedupe(`${name}:${key}`));

export const queueCustomerSheetSync = (customerId: string) => enqueueDeduped("sheet.sync.customer", { customerId }, customerId);
export const queueAccountingSheetSync = (customerId: string) => enqueueDeduped("sheet.sync.accounting", { customerId }, customerId);

export const queueWarehouseSheetSync = (opts?: { recentDays?: number }) =>
  enqueueDeduped("sheet.sync.warehouse", { action: "full", recentDays: opts?.recentDays }, `full:${opts?.recentDays ?? "all"}`);

export const queueWarehousePackedOne = (code: string, tab?: string, row?: number, bill?: string, thung?: string) =>
  enqueueDeduped("sheet.sync.warehouse", { action: "one", code, tab, row, bill, thung }, `one:${code}|${tab ?? ""}|${row ?? ""}|${bill ?? ""}|${thung ?? ""}`);

export const queueWarehouseRowClear = (packedAt: Date | null, row: number | null) => {
  if (!packedAt || row == null) return Promise.resolve();
  return enqueue("sheet.sync.warehouse", { action: "clearRow", packedAt: packedAt.toISOString(), row });
};

export const queueTrackingSheetRow = (trackingId: string) =>
  enqueueDeduped("sheet.sync.warehouse", { action: "trackingRow", trackingId }, `trk:${trackingId}`);

export const queueTrackingSheetRowRemoval = (trackingId: string) =>
  enqueue("sheet.sync.warehouse", { action: "removeTrackingRow", trackingId });
