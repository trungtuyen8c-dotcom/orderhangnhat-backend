import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { order: { findMany: vi.fn() } },
}));
vi.mock("../redis.js", () => ({
  redis: { set: vi.fn() },
}));
vi.mock("../utils/systemLog.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

import { scanLateOrders } from "./alerts.js";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { logWarn } from "../utils/systemLog.js";

const mockPrisma = prisma as unknown as { order: { findMany: ReturnType<typeof vi.fn> } };
const mockRedis = redis as unknown as { set: ReturnType<typeof vi.fn> };
const mockLogWarn = logWarn as unknown as ReturnType<typeof vi.fn>;

describe("scanLateOrders", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scanLateOrders_ordersFound_queriesPaidOrdersOlderThan7DaysWithNoTracking", async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    await scanLateOrders();
    const args = mockPrisma.order.findMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ notIn: ["completed", "closed", "cancelled"] });
    expect(args.where.trackings).toEqual({ none: {} });
    expect(args.where.paidAt.not).toBeNull();
    expect(args.where.paidAt.lt).toBeInstanceOf(Date);
  });

  it("scanLateOrders_noLateOrders_returnsEmptyArrayAndDoesNotLogWarn", async () => {
    mockPrisma.order.findMany.mockResolvedValue([]);
    const result = await scanLateOrders();
    expect(result).toEqual([]);
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it("scanLateOrders_lateOrdersFound_returnsTheirCodes", async () => {
    mockPrisma.order.findMany.mockResolvedValue([
      { id: "o1", code: "DH001", paidAt: new Date() },
      { id: "o2", code: "DH002", paidAt: new Date() },
    ]);
    const result = await scanLateOrders();
    expect(result).toEqual(["DH001", "DH002"]);
  });

  it("scanLateOrders_lateOrdersFound_logsWarnWithCountAndCodes", async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o1", code: "DH001", paidAt: new Date() }]);
    await scanLateOrders();
    expect(mockLogWarn).toHaveBeenCalledWith({ count: 1, codes: ["DH001"] }, "late_orders_no_tracking");
  });

  it("scanLateOrders_anyResult_cachesResultInRedisWith24hTtl", async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o1", code: "DH001", paidAt: new Date() }]);
    await scanLateOrders();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [key, payload, mode, ttl] = mockRedis.set.mock.calls[0];
    expect(key).toBe("alerts:late_orders");
    expect(mode).toBe("EX");
    expect(ttl).toBe(86400);
    const parsed = JSON.parse(payload as string);
    expect(parsed.count).toBe(1);
    expect(parsed.orders).toEqual([{ id: "o1", code: "DH001", paidAt: expect.any(String) }]);
  });
});
