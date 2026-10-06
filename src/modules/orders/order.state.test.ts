import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { order: { updateMany: vi.fn() } },
}));

import {
  bumpOrderStatus, canTransition, assertTransition, systemSourcesFor, isEditable,
  ORDER_STATUSES, INITIAL_STATUS,
} from "./order.state.js";
import { prisma } from "../../infrastructure/prisma.js";
import { AppError } from "../../app/errors/AppError.js";

const mockPrisma = prisma as unknown as { order: { updateMany: ReturnType<typeof vi.fn> } };

describe("bumpOrderStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.order.updateMany.mockResolvedValue({ count: 1 });
  });

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

  it("bumpOrderStatus_txProvided_writesThroughTxNotGlobalPrisma", async () => {
    const tx: any = { order: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) } };
    const n = await bumpOrderStatus(["o1", "o2"], "vn_warehouse", tx);
    expect(n).toBe(2);
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("bumpOrderStatus_targetDraft_noEarlierStatus_doesNotWrite", async () => {
    expect(await bumpOrderStatus(["o1"], "draft")).toBe(0);
    expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
  });
});

describe("systemSourcesFor", () => {
  it("systemSourcesFor_vnWarehouse_includesEverythingBeforeIt", () => {
    expect(systemSourcesFor("vn_warehouse")).toEqual([
      "draft", "quoted", "deposited", "purchasing", "purchased", "jp_warehouse", "customs", "tax_done",
    ]);
  });

  it("systemSourcesFor_cancelled_isNotInSequence_returnsEmpty", () => {
    expect(systemSourcesFor("cancelled")).toEqual([]);
  });
});

describe("canTransition", () => {
  it("canTransition_manualAnyPair_allowed_freeSelectionLikeToday", () => {
    for (const from of ORDER_STATUSES) for (const to of ORDER_STATUSES) expect(canTransition(from, to, "manual")).toBe(true);
  });

  it("canTransition_manualBackwardsFromDelivered_allowed", () => {
    expect(canTransition("delivered", "quoted", "manual")).toBe(true);
  });

  it("canTransition_manualUnknownTarget_rejected", () => {
    expect(canTransition("quoted", "shipped" as any, "manual")).toBe(false);
  });

  it("canTransition_systemForward_allowed", () => {
    expect(canTransition("purchased", "jp_warehouse", "system")).toBe(true);
  });

  it("canTransition_systemBackward_rejected", () => {
    expect(canTransition("vn_warehouse", "jp_warehouse", "system")).toBe(false);
  });

  it("canTransition_systemFromFrozen_rejected", () => {
    expect(canTransition("cancelled", "delivered", "system")).toBe(false);
    expect(canTransition("completed", "closed", "system")).toBe(false);
  });

  it("canTransition_systemSameStatus_rejected", () => {
    expect(canTransition("jp_warehouse", "jp_warehouse", "system")).toBe(false);
  });
});

describe("assertTransition", () => {
  it("assertTransition_invalidSystemTransition_throwsStateInvalid409", () => {
    try {
      assertTransition("delivered", "jp_warehouse", "system");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(409);
      expect((e as AppError).code).toBe("STATE_INVALID_TRANSITION");
    }
  });

  it("assertTransition_validManual_doesNotThrow", () => {
    expect(() => assertTransition("closed", "quoted", "manual")).not.toThrow();
  });
});

describe("isEditable / INITIAL_STATUS", () => {
  it("isEditable_draftOrQuoted_true_otherwiseFalse", () => {
    expect(isEditable("draft")).toBe(true);
    expect(isEditable("quoted")).toBe(true);
    expect(isEditable("deposited")).toBe(false);
    expect(isEditable("cancelled")).toBe(false);
  });

  it("initialStatus_orderIsQuoted_consignmentIsVnWarehouse", () => {
    expect(INITIAL_STATUS.order).toBe("quoted");
    expect(INITIAL_STATUS.consignment).toBe("vn_warehouse");
  });
});
