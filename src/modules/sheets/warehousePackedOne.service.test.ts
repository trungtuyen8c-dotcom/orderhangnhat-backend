import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.hoisted(() => { process.env.TZ = "UTC"; });
vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    appConfig: { findUnique: vi.fn() },
    packDayLock: { findUnique: vi.fn() },
    tracking: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    carton: { findFirst: vi.fn(), create: vi.fn() },
    order: { findUnique: vi.fn() },
  },
}));
vi.mock("../../integrations/google/googleAuth.js", () => ({ serviceAccountEnabled: vi.fn(() => true) }));
vi.mock("../../integrations/google/googleSheets.client.js", async (orig) => ({
  ...(await orig<object>()),
  batchGetValues: vi.fn(),
  batchUpdateValues: vi.fn(),
  batchUpdate: vi.fn(),
  getSheetIdByTitle: vi.fn(),
}));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../orders/order.state.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn() }));
vi.mock("./customerSheetSync.service.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("../cartons/carton.service.js", () => ({ deleteCartonIfEmpty: vi.fn() }));

import { prisma } from "../../infrastructure/prisma.js";
import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import { batchGetValues, batchUpdate, batchUpdateValues, getSheetIdByTitle } from "../../integrations/google/googleSheets.client.js";
import type { SheetsRequest, ValueRangeUpdate } from "../../integrations/google/google.types.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { logError } from "../../infrastructure/systemLog.js";
import { syncCustomerOrders } from "./customerSheetSync.service.js";
import { LATE_NOTE, ORANGE, PURPLE, WHITE, type TrackingWithOrder } from "./warehouseSheet.shared.js";
import { syncPackedOne } from "./warehousePackedOne.service.js";

type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  appConfig: { findUnique: Fn }; packDayLock: { findUnique: Fn };
  tracking: { findMany: Fn; update: Fn; delete: Fn; create: Fn; findFirst: Fn };
  trackingLog: { deleteMany: Fn }; carton: { findFirst: Fn; create: Fn }; order: { findUnique: Fn };
};
const mGet = vi.mocked(batchGetValues);
const mValues = vi.mocked(batchUpdateValues);
const mFormat = vi.mocked(batchUpdate);

const CODE = "ABC12345";
const DAY = new Date("2026-06-26T00:00:00Z");

type Ord = NonNullable<TrackingWithOrder["order"]>;
function order(id: string, items: { name: string; price: number; url?: string }[], extra: Partial<Ord> = {}): Ord {
  return {
    id, code: id, customerId: `cust-${id}`, needsCheck: false, checkNote: null, trackings: [],
    items: items.map((i) => ({ id: `i-${i.name}`, name: i.name, qty: 1, unitPriceJpy: new Prisma.Decimal(i.price), shipJpy: null, url: i.url ?? null })),
    ...extra,
  } as unknown as Ord;
}
function trk(id: string, ord: Ord | null, extra: Partial<TrackingWithOrder> = {}): TrackingWithOrder {
  const t = {
    id, code: CODE, orderId: ord?.id ?? null, order: ord, packedAt: DAY, needsTax: true, lateAfterLock: false,
    packRow: null, cartonId: null, cartonManual: false, customsName: null, ...extra,
  } as unknown as TrackingWithOrder;
  if (ord) (ord as unknown as { trackings: unknown[] }).trackings.push(t);
  return t;
}

// Bảng giá trị F/X hiện tại của dòng (đọc lại trước khi ghi).
function sheetRowState(f = "", x = "") {
  mGet.mockResolvedValue([{ values: f ? [[f]] : [] }, { values: x ? [[x]] : [] }]);
}
function setup(o: { group?: TrackingWithOrder[]; locked?: boolean; staleOnRow?: unknown[] } = {}) {
  db.appConfig.findUnique.mockResolvedValue({ value: "1234567890abcdefghijXYZ" });
  db.packDayLock.findUnique.mockResolvedValue(o.locked ? { date: DAY } : null);
  db.tracking.findMany.mockImplementation(async (args: { where: { code: unknown } }) =>
    typeof args.where.code === "string" ? (o.group ?? []) : (o.staleOnRow ?? []));
  db.order.findUnique.mockResolvedValue(null);
  vi.mocked(getSheetIdByTitle).mockResolvedValue(9);
  sheetRowState();
}
const writtenValues = (): ValueRangeUpdate[] => mValues.mock.calls.flatMap((c) => c[1]);
const valueAt = (range: string) => writtenValues().find((d) => d.range === range)?.values;
const formatReqs = (): SheetsRequest[] => mFormat.mock.calls.flatMap((c) => c[1]);
const rowColor = () => (formatReqs()[0] as { repeatCell: { cell: { userEnteredFormat: { backgroundColor: unknown } } } }).repeatCell.cell.userEnteredFormat.backgroundColor;
const trackingUpdates = () => db.tracking.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(serviceAccountEnabled).mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("syncPackedOne - guards", () => {
  it("syncPackedOne_serviceAccountDisabled_returnsNotMatchedWithoutDb", async () => {
    vi.mocked(serviceAccountEnabled).mockReturnValue(false);
    expect(await syncPackedOne(CODE, "26.6", 3)).toEqual({ matched: false });
    expect(db.tracking.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { name: "too short", code: "ABC123" },
    { name: "contains space", code: "ABC 12345" },
    { name: "empty", code: "" },
  ])("syncPackedOne_invalidCode_$name_returnsNotMatched", async ({ code }) => {
    setup();
    expect(await syncPackedOne(code, "26.6", 3)).toEqual({ matched: false });
  });

  it("syncPackedOne_noWarehouseSheetConfigured_returnsNotMatched", async () => {
    setup();
    db.appConfig.findUnique.mockResolvedValue(null);
    expect(await syncPackedOne(CODE, "26.6", 3)).toEqual({ matched: false });
  });
});

describe("syncPackedOne - tracking state", () => {
  it("syncPackedOne_unknownCode_createsOrphanPackedOnTabDayNeedingTax", async () => {
    setup({ group: [] });
    db.tracking.create.mockImplementation(async ({ data }: { data: object }) => ({ ...data }));
    const res = await syncPackedOne(" ABC12345 ", "26.6", 3);
    const data = db.tracking.create.mock.calls[0][0].data;
    expect(res).toEqual({ matched: true });
    expect({ code: data.code, packedAt: data.packedAt, status: data.status, lateAfterLock: data.lateAfterLock, needsTax: data.needsTax })
      .toEqual({ code: CODE, packedAt: DAY, status: "new", lateAfterLock: false, needsTax: true });
  });

  it("syncPackedOne_unknownCodeOnLockedDay_createsOrphanFlaggedLateAfterLock", async () => {
    setup({ group: [], locked: true });
    db.tracking.create.mockImplementation(async ({ data }: { data: object }) => ({ ...data }));
    await syncPackedOne(CODE, "26.6", 3);
    expect(db.tracking.create.mock.calls[0][0].data.lateAfterLock).toBe(true);
  });

  it("syncPackedOne_lockLookup_queriesLocalMidnightOfTabDay", async () => {
    setup({ group: [] });
    db.tracking.create.mockImplementation(async ({ data }: { data: object }) => ({ ...data }));
    await syncPackedOne(CODE, "26.6", 3);
    expect(db.packDayLock.findUnique).toHaveBeenCalledWith({ where: { date: new Date("2026-06-26T00:00:00Z") } });
  });

  it("syncPackedOne_unpackedLinkedTracking_marksPackedNeedsTaxAndBumpsOrderToJpWarehouse", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packedAt: null, needsTax: false });
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(trackingUpdates()[0]).toEqual({ where: { id: "t1" }, data: { packedAt: DAY, lateAfterLock: false, needsTax: true } });
    expect(bumpOrderStatus).toHaveBeenCalledWith("O1", "jp_warehouse");
  });

  it("syncPackedOne_noTabGiven_fallsBackToExistingPackedAt", async () => {
    const earlier = new Date("2026-06-20T00:00:00Z");
    const t = trk("t1", null, { packedAt: earlier, needsTax: false });
    setup({ group: [t] });
    await syncPackedOne(CODE);
    expect(trackingUpdates()[0].data.packedAt).toBe(earlier);
  });

  it("syncPackedOne_alreadyPackedAndNeedsTax_doesNotRewritePackedAt", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 3 });
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(trackingUpdates().some((u) => "packedAt" in u.data)).toBe(false);
    expect(bumpOrderStatus).not.toHaveBeenCalled();
  });

  it("syncPackedOne_singleTrackingOnNewRow_savesPackRow", async () => {
    const t = trk("t1", null, { packRow: 2 });
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6", 7);
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { packRow: 7 } });
  });

  it("syncPackedOne_sharedCodeTwoTrackings_doesNotOverwritePackRow", async () => {
    const a = trk("ta", null, { packRow: 2 }), b = trk("tb", null, { packRow: 4 });
    setup({ group: [a, b] });
    await syncPackedOne(CODE, "26.6", 7);
    expect(trackingUpdates().some((u) => "packRow" in u.data)).toBe(false);
  });

  it("syncPackedOne_linkedTracking_recomputesTotalsAndSyncsCustomerSheet", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]));
    setup({ group: [t] });
    db.order.findUnique.mockResolvedValue({ customerId: "cust-9" });
    await syncPackedOne(CODE);
    expect(recomputeOrderTotals).toHaveBeenCalledWith("O1");
    expect(syncCustomerOrders).toHaveBeenCalledWith("cust-9");
  });
});

describe("syncPackedOne - stale codes on same row", () => {
  it("syncPackedOne_otherOrphanCodeOnSameRowSameDay_deletesIt", async () => {
    const t = trk("t1", null, { packRow: 3 });
    setup({ group: [t], staleOnRow: [{ id: "old", code: "OLD99999", orderId: null, cartonId: null, packedAt: DAY }] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(db.tracking.delete).toHaveBeenCalledWith({ where: { id: "old" } });
  });

  it("syncPackedOne_otherCodeOnSameRowDifferentDay_keepsIt", async () => {
    const t = trk("t1", null, { packRow: 3 });
    setup({ group: [t], staleOnRow: [{ id: "old", code: "OLD99999", orderId: null, cartonId: null, packedAt: new Date("2026-06-25T00:00:00Z") }] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  it("syncPackedOne_otherCodeOnSameRowButDayLocked_keepsIt", async () => {
    const t = trk("t1", null, { packRow: 3 });
    setup({ group: [t], locked: true, staleOnRow: [{ id: "old", code: "OLD99999", orderId: null, cartonId: null, packedAt: DAY }] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(db.tracking.findMany).toHaveBeenCalledTimes(1);
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });
});

describe("syncPackedOne - carton", () => {
  it("syncPackedOne_billAndThungGiven_assignsResolvedCarton", async () => {
    const t = trk("t1", null, { packRow: 3 });
    setup({ group: [t] });
    db.carton.findFirst.mockResolvedValue({ id: "c1" });
    await syncPackedOne(CODE, "26.6", 3, "ga", "2");
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { cartonId: "c1" } });
  });

  it("syncPackedOne_cartonManualTracking_keepsCartonUntouched", async () => {
    const t = trk("t1", null, { packRow: 3, cartonManual: true, cartonId: "manual" });
    setup({ group: [t] });
    db.carton.findFirst.mockResolvedValue({ id: "c1" });
    await syncPackedOne(CODE, "26.6", 3, "ga", "2");
    expect(trackingUpdates().some((u) => "cartonId" in u.data)).toBe(false);
  });
});

describe("syncPackedOne - write back row", () => {
  it("syncPackedOne_singleTracking_writesNameAndPriceToFG", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(valueAt("'26.6'!F3:G3")).toEqual([["Bag", 1500]]);
  });

  it("syncPackedOne_sharedCodeRowMatchesPackRow_writesOnlyThatOrdersItem", async () => {
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]), { packRow: 2 });
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]), { packRow: 3 });
    setup({ group: [a, b] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(valueAt("'26.6'!F3:G3")).toEqual([["Shoe", 2000]]);
  });

  it("syncPackedOne_sharedCodeRowUnknown_writesMergedNamesAndSharedNote", async () => {
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]), { packRow: 2 });
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]), { packRow: 4 });
    setup({ group: [a, b] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(valueAt("'26.6'!F3:G3")).toEqual([["Bag + Shoe", 3000]]);
    expect(valueAt("'26.6'!U3:W3")).toEqual([["Mã dùng chung 2 đơn - đã quét 1/2 dòng", "", 2]]);
  });

  it("syncPackedOne_khoRenamedCell_keepsSheetNameSavesCustomsNameAndColorsOrange", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t] });
    sheetRowState("Leather handbag");
    await syncPackedOne(CODE, "26.6", 3);
    expect(valueAt("'26.6'!F3:G3")).toBeUndefined();
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { customsName: "Leather handbag" } });
    expect(rowColor()).toBe(ORANGE);
  });

  it("syncPackedOne_cellHoldsOldMergedName_overwritesWithSingleItemAndClearsCustomsName", async () => {
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]), { packRow: 2, customsName: "Shoe + Bag" });
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]), { packRow: 3 });
    setup({ group: [a, b] });
    sheetRowState("Shoe + Bag");
    await syncPackedOne(CODE, "26.6", 2);
    expect(valueAt("'26.6'!F2:G2")).toEqual([["Bag", 1000]]);
    expect(trackingUpdates()).toContainEqual({ where: { id: "ta" }, data: { customsName: null } });
  });

  it("syncPackedOne_lockedDayNotResolved_writesLateNoteAndColorsPurple", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t], locked: true });
    await syncPackedOne(CODE, "26.6", 3);
    expect(valueAt("'26.6'!U3:W3")?.[0][0]).toBe(LATE_NOTE);
    expect(rowColor()).toBe(PURPLE);
  });

  it("syncPackedOne_resolvedLateRow_resetsLateFlagClearsXAndColorsWhite", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3, lateAfterLock: true });
    setup({ group: [t] });
    sheetRowState("", "TRUE");
    await syncPackedOne(CODE, "26.6", 3);
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { lateAfterLock: false } });
    expect(valueAt("'26.6'!X3")).toEqual([[""]]);
    expect(rowColor()).toBe(WHITE);
  });

  it("syncPackedOne_plainRow_whiteWithoutCheckbox", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6", 3);
    expect(formatReqs()[1]).toEqual({ setDataValidation: { range: { sheetId: 9, startRowIndex: 2, endRowIndex: 3, startColumnIndex: 23, endColumnIndex: 24 } } });
  });

  it("syncPackedOne_tabNotFound_writesValuesButSkipsFormatting", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t] });
    vi.mocked(getSheetIdByTitle).mockResolvedValue(null);
    await syncPackedOne(CODE, "26.6", 3);
    expect(mValues).toHaveBeenCalled();
    expect(mFormat).not.toHaveBeenCalled();
  });

  it("syncPackedOne_noRowGiven_doesNotTouchSheet", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]));
    setup({ group: [t] });
    await syncPackedOne(CODE, "26.6");
    expect(mValues).not.toHaveBeenCalled();
  });

  it("syncPackedOne_sheetWriteFails_logsErrorAndStillReportsMatched", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1500 }]), { packRow: 3 });
    setup({ group: [t] });
    mValues.mockRejectedValueOnce(new Error("GSHEET_API 403"));
    expect(await syncPackedOne(CODE, "26.6", 3)).toEqual({ matched: true });
    expect(logError).toHaveBeenCalledWith({ err: "GSHEET_API 403" }, "gsheets_sync_packed_one_failed");
  });
});
