import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { order: { updateMany: vi.fn() } },
}));

import { bumpOrderStatus } from "./orderStatus.js";
import { prisma } from "../db.js";

const mockPrisma = prisma as unknown as { order: { updateMany: ReturnType<typeof vi.fn> } };

describe("bumpOrderStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("bumpOrderStatus_targetJpWarehouse_allowedFromExcludesTargetAndLaterStatuses", async () => {
    await bumpOrderStatus(["o1"], "jp_warehouse");
    const call = mockPrisma.order.updateMany.mock.calls[0][0];
    expect(call.where.status.in).toEqual(["draft", "quoted", "deposited", "purchasing", "purchased"]);
    expect(call.data).toEqual({ status: "jp_warehouse" });
  });

  it("bumpOrderStatus_anyTarget_excludesFrozenStatuses", async () => {
    await bumpOrderStatus(["o1"], "delivered");
    const allowedFrom: string[] = mockPrisma.order.updateMany.mock.calls[0][0].where.status.in;
    expect(allowedFrom).not.toContain("completed");
    expect(allowedFrom).not.toContain("closed");
    expect(allowedFrom).not.toContain("cancelled");
  });

  it("bumpOrderStatus_emptyIdsArray_doesNotCallUpdateMany", async () => {
    await bumpOrderStatus([], "delivered");
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("bumpOrderStatus_invalidTarget_doesNotCallUpdateMany", async () => {
    await bumpOrderStatus(["o1"], "not_a_real_status" as any);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("bumpOrderStatus_singleIdString_normalizedToArrayInWhereIdIn", async () => {
    await bumpOrderStatus("o1", "delivered");
    expect(mockPrisma.order.updateMany.mock.calls[0][0].where.id.in).toEqual(["o1"]);
  });

  it("bumpOrderStatus_multipleIds_allPassedToWhereIdIn", async () => {
    await bumpOrderStatus(["o1", "o2", "o3"], "delivered");
    expect(mockPrisma.order.updateMany.mock.calls[0][0].where.id.in).toEqual(["o1", "o2", "o3"]);
  });
});
