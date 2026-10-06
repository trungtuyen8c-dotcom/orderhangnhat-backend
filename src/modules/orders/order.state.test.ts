import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { order: { updateMany: vi.fn() } },
}));

import {
  bumpOrderStatus, canTransition, assertUserTransition, systemSourcesFor, isEditable, allowedActions,
  checkTransitionPrerequisites, findTransitionTo, ORDER_ACTIONS, ORDER_STATUSES, INITIAL_STATUS, USER_TRANSITIONS,
  ACTION_LABEL, type OrderAction,
} from "./order.state.js";
import { prisma } from "../../infrastructure/prisma.js";
import { LegacyError } from "../../app/http/legacyError.js";

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

const EXPECTED_TABLE: [string, OrderAction, string][] = [
  ["draft", "quote", "quoted"],
  ["quoted", "deposit", "deposited"],
  ["quoted", "start-purchasing", "purchasing"],
  ["deposited", "start-purchasing", "purchasing"],
  ["purchasing", "mark-purchased", "purchased"],
  ["purchased", "receive-jp", "jp_warehouse"],
  ["jp_warehouse", "start-customs", "customs"],
  ["customs", "complete-tax", "tax_done"],
  ["tax_done", "receive-vn", "vn_warehouse"],
  ["vn_warehouse", "deliver", "delivered"],
  ["delivered", "complete", "completed"],
  ["completed", "close", "closed"],
  ["quoted", "cancel", "cancelled"],
  ["deposited", "cancel", "cancelled"],
];

describe("USER_TRANSITIONS table", () => {
  it("table_givenOwnerDecision_whenListed_thenExactlyMatchesTheApprovedRows", () => {
    expect(USER_TRANSITIONS.map((t) => [t.from, t.action, t.to])).toEqual(EXPECTED_TABLE);
  });

  it("table_givenEveryAction_whenLookedUp_thenUsedAtLeastOnceAndHasVietnameseLabel", () => {
    for (const a of ORDER_ACTIONS) {
      expect(USER_TRANSITIONS.some((t) => t.action === a)).toBe(true);
      expect(ACTION_LABEL[a]).toBeTruthy();
    }
  });

  it("table_givenTerminalStatuses_whenAskingActions_thenNone", () => {
    expect(allowedActions("closed")).toEqual([]);
    expect(allowedActions("cancelled")).toEqual([]);
  });

  it("table_givenEveryStatusExceptTerminal_whenAskingActions_thenAtLeastOne", () => {
    for (const s of ORDER_STATUSES) {
      if (s === "closed" || s === "cancelled") continue;
      expect(allowedActions(s).length).toBeGreaterThan(0);
    }
  });

  it("allowedActions_givenQuoted_whenAsked_thenDepositStartPurchasingCancelWithLabels", () => {
    expect(allowedActions("quoted")).toEqual([
      { action: "deposit", to: "deposited", label: "Xác nhận đã cọc" },
      { action: "start-purchasing", to: "purchasing", label: "Bắt đầu mua" },
      { action: "cancel", to: "cancelled", label: "Hủy đơn" },
    ]);
  });
});

describe("assertUserTransition", () => {
  it.each(EXPECTED_TABLE)("assertUserTransition_given%s_when%s_thenReturns%s", (from, action, to) => {
    expect(assertUserTransition(from as any, action).to).toBe(to);
  });

  const invalid: [string, OrderAction][] = [
    ["quoted", "mark-purchased"], // nhảy cóc
    ["draft", "deliver"], // nhảy cóc
    ["purchased", "start-purchasing"], // lùi
    ["delivered", "receive-vn"], // lùi
    ["closed", "close"], ["closed", "quote"], ["cancelled", "quote"], ["cancelled", "cancel"], // từ trạng thái cuối
    ["purchasing", "cancel"], ["purchased", "cancel"], ["jp_warehouse", "cancel"], ["delivered", "cancel"], ["draft", "cancel"],
  ];
  it.each(invalid)("assertUserTransition_given%s_when%s_thenThrows409StateInvalidTransition", (from, action) => {
    try {
      assertUserTransition(from as any, action);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LegacyError);
      expect((e as LegacyError).status).toBe(409);
      expect((e as LegacyError).toBody()).toMatchObject({ error: "STATE_INVALID_TRANSITION", detail: { from, action } });
    }
  });
});

describe("checkTransitionPrerequisites", () => {
  it("prerequisites_givenOrderAtFrom_whenChecked_thenNoBusinessRuleBlocks", () => {
    const t = assertUserTransition("quoted", "deposit");
    expect(() => checkTransitionPrerequisites({ status: "quoted" }, t)).not.toThrow();
  });

  it("prerequisites_givenOrderNotAtFrom_whenChecked_thenThrows409", () => {
    const t = assertUserTransition("quoted", "deposit");
    expect(() => checkTransitionPrerequisites({ status: "purchasing" }, t)).toThrow(LegacyError);
  });
});

describe("canTransition / findTransitionTo", () => {
  it("canTransition_givenUserModeTableRow_thenAllowed_otherwiseRejected", () => {
    expect(canTransition("quoted", "purchasing", "user")).toBe(true);
    expect(canTransition("delivered", "quoted", "user")).toBe(false);
    expect(canTransition("cancelled", "quoted", "user")).toBe(false);
  });

  it("canTransition_givenCorrectionMode_thenAnyValidStatusAllowed", () => {
    for (const from of ORDER_STATUSES) for (const to of ORDER_STATUSES) expect(canTransition(from, to, "correction")).toBe(true);
    expect(canTransition("quoted", "shipped" as any, "correction")).toBe(false);
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

  it("findTransitionTo_givenNextStatus_thenReturnsAction_givenSkip_thenUndefined", () => {
    expect(findTransitionTo("deposited", "purchasing")?.action).toBe("start-purchasing");
    expect(findTransitionTo("quoted", "purchased")).toBeUndefined();
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
