// Report stats_*. stats_alerts dùng chung stats.service; stats_overview giữ bản rút gọn riêng (chỉ 3 số đếm) -
// getOverview() của stats.service quét toàn bộ đơn còn sống để tính completed/inProgress, quá nặng cho 1 lượt gọi MCP
// và trả thêm field ngoài contract ext hiện tại.
import { prisma } from "../../../infrastructure/prisma.js";
import { getAlerts } from "../../stats/stats.service.js";

export async function stats_overview() {
  const [byStatus, customers, totalOrders] = await Promise.all([
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.customer.count(),
    prisma.order.count(),
  ]);
  return { totalOrders, customers, byStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })) };
}

export const stats_alerts = () => getAlerts();
