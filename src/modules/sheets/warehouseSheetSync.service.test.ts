import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.hoisted(() => { process.env.TZ = "UTC"; });
vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    appConfig: { findUnique: vi.fn() },
    packDayLock: { findMany: vi.fn(), upsert: vi.fn(), deleteMany: vi.fn() },
    tracking: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn(), create: vi.fn(), findFirst: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    carton: { findFirst: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("../../integrations/google/googleAuth.js", () => ({ serviceAccountEnabled: vi.fn(() => true) }));
vi.mock("../../integrations/google/googleSheets.client.js", async (orig) => ({
  ...(await orig<object>()),
  listSheets: vi.fn(),
  batchGetValues: vi.fn(),
  batchUpdateValues: vi.fn(),
  batchUpdate: vi.fn(),
}));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../orders/order.state.js", () => ({ bumpOrderStatus: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn() }));
vi.mock("./customerSheetSync.service.js", () => ({ syncCustomerOrders: vi.fn() }));
vi.mock("./trackingSheetSync.service.js", () => ({ syncTracking: vi.fn() }));
vi.mock("../cartons/carton.service.js", () => ({ deleteCartonIfEmpty: vi.fn() }));

import { prisma } from "../../infrastructure/prisma.js";
import { serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import { batchGetValues, batchUpdate, batchUpdateValues, listSheets } from "../../integrations/google/googleSheets.client.js";
import type { SheetsRequest, ValueRangeUpdate } from "../../integrations/google/google.types.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import { bumpOrderStatus } from "../orders/order.state.js";
import { logError } from "../../infrastructure/systemLog.js";
import { syncCustomerOrders } from "./customerSheetSync.service.js";
import { GREEN, LATE_NOTE, ORANGE, PURPLE, RED, WHITE, YELLOW, type TrackingWithOrder } from "./warehouseSheet.shared.js";
import { clearWarehouseRow, setDayLockFromTab, syncPackedFromWarehouse } from "./warehouseSheetSync.service.js";

type Fn = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  appConfig: { findUnique: Fn }; packDayLock: { findMany: Fn; upsert: Fn; deleteMany: Fn };
  tracking: { findMany: Fn; update: Fn; delete: Fn; create: Fn; findFirst: Fn };
  trackingLog: { deleteMany: Fn }; carton: { findFirst: Fn; create: Fn };
};
const mList = vi.mocked(listSheets);
const mGet = vi.mocked(batchGetValues);
const mValues = vi.mocked(batchUpdateValues);
const mFormat = vi.mocked(batchUpdate);

const CODE = "ABC12345";
const D26 = new Date("2026-06-26T00:00:00Z");
const D20 = new Date("2026-06-20T00:00:00Z");

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
    id, code: CODE, orderId: ord?.id ?? null, order: ord, packedAt: D26, needsTax: true, lateAfterLock: false,
    packRow: null, cartonId: null, cartonManual: false, customsName: null, ...extra,
  } as unknown as TrackingWithOrder;
  if (ord) (ord as unknown as { trackings: unknown[] }).trackings.push(t);
  return t;
}

// 1 tab kho: phần tử thứ i = dòng i+1 (A=BILL, B=thùng, E=mã, F=tên, X=đã xử lý).
type Cell = { A?: string; B?: string; E?: string; F?: string; X?: string };
function tabColumns(rows: Cell[]): string[][] {
  const cols: string[][] = Array.from({ length: 24 }, () => []);
  rows.forEach((r, j) => { cols[0][j] = r.A ?? ""; cols[1][j] = r.B ?? ""; cols[4][j] = r.E ?? ""; cols[5][j] = r.F ?? ""; cols[23][j] = r.X ?? ""; });
  return cols;
}
function setup(o: { tabs: Record<string, Cell[]>; trks?: TrackingWithOrder[]; candidates?: unknown[]; locked?: Date[] }) {
  db.appConfig.findUnique.mockResolvedValue({ value: "1234567890abcdefghijXYZ" });
  const titles = Object.keys(o.tabs);
  mList.mockResolvedValue(titles.map((title, i) => ({ title, sheetId: 100 + i })));
  mGet.mockImplementation(async (_sid, ranges) => ranges.map((r) => ({ values: tabColumns(o.tabs[r.slice(1, r.indexOf("'!"))]) })));
  db.packDayLock.findMany.mockResolvedValue((o.locked ?? []).map((date) => ({ date })));
  // Lọc packedAt >= gte như Prisma để test được mốc recentDays.
  db.tracking.findMany.mockImplementation(async (args: { where: { packRow?: unknown; packedAt?: { gte?: Date } } }) => {
    if (!args.where.packRow) return o.trks ?? [];
    const gte = args.where.packedAt?.gte;
    return ((o.candidates ?? []) as { packedAt: Date }[]).filter((c) => !gte || c.packedAt >= gte);
  });
  db.tracking.create.mockImplementation(async ({ data }: { data: object }) => ({ ...data, orderId: null, packRow: null, cartonId: null, cartonManual: false, customsName: null }));
  db.carton.findFirst.mockResolvedValue(null);
  db.carton.create.mockImplementation(async ({ data }: { data: { code: string } }) => ({ id: `carton-${data.code}` }));
}
const writtenValues = (): ValueRangeUpdate[] => mValues.mock.calls.flatMap((c) => c[1]);
const valueAt = (range: string) => writtenValues().find((d) => d.range === range)?.values;
const formatReqs = (): SheetsRequest[] => mFormat.mock.calls.flatMap((c) => c[1]);
// Màu nền đã ghi cho 1 dòng (sheetId tab đầu tiên = 100).
function rowColor(row: number, sheetId = 100) {
  const req = formatReqs().find((r) => {
    const rc = (r as { repeatCell?: { range: { sheetId: number; startRowIndex: number } } }).repeatCell;
    return rc && rc.range.sheetId === sheetId && rc.range.startRowIndex === row - 1;
  }) as { repeatCell: { cell: { userEnteredFormat: { backgroundColor: unknown } } } } | undefined;
  return req?.repeatCell.cell.userEnteredFormat.backgroundColor;
}
const trackingUpdates = () => db.tracking.update.mock.calls.map((c) => c[0] as { where: { id: string }; data: Record<string, unknown> });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(serviceAccountEnabled).mockReturnValue(true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("syncPackedFromWarehouse - guards", () => {
  it("syncPackedFromWarehouse_noWarehouseSheetConfigured_returnsZeroWithoutReadingSheet", async () => {
    db.appConfig.findUnique.mockResolvedValue(null);
    expect(await syncPackedFromWarehouse()).toEqual({ matched: 0, updated: 0 });
    expect(mList).not.toHaveBeenCalled();
  });

  it("syncPackedFromWarehouse_noTrackingCodesInSheet_returnsZero", async () => {
    setup({ tabs: { "26.6": [{ E: "Mã" }] } });
    expect(await syncPackedFromWarehouse()).toEqual({ matched: 0, updated: 0 });
  });
});

describe("syncPackedFromWarehouse - packing state", () => {
  it("syncPackedFromWarehouse_unknownCode_createsOrphanPackedOnTabDayNeedingTax", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [] });
    const res = await syncPackedFromWarehouse();
    const data = db.tracking.create.mock.calls[0][0].data;
    expect({ code: data.code, packedAt: data.packedAt, status: data.status, lateAfterLock: data.lateAfterLock, needsTax: data.needsTax })
      .toEqual({ code: CODE, packedAt: D26, status: "new", lateAfterLock: false, needsTax: true });
    expect(res).toEqual({ matched: 1, updated: 0 });
  });

  it("syncPackedFromWarehouse_unknownCodeOnLockedDay_createsOrphanFlaggedLateAfterLock", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [], locked: [D26] });
    await syncPackedFromWarehouse();
    expect(db.tracking.create.mock.calls[0][0].data.lateAfterLock).toBe(true);
  });

  it("syncPackedFromWarehouse_unpackedTracking_marksPackedOnTabDayAndCountsUpdated", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packedAt: null, needsTax: false });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    const res = await syncPackedFromWarehouse();
    expect(trackingUpdates()[0]).toEqual({ where: { id: "t1" }, data: { packedAt: D26, lateAfterLock: false, needsTax: true } });
    expect(res).toEqual({ matched: 1, updated: 1 });
  });

  it("syncPackedFromWarehouse_unpackedTrackingOnLockedDay_marksLateAfterLock", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packedAt: null });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t], locked: [D26] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates()[0].data.lateAfterLock).toBe(true);
  });

  it("syncPackedFromWarehouse_unpackedLinkedTracking_bumpsOrderRecomputesAndSyncsCustomer", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packedAt: null });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(bumpOrderStatus).toHaveBeenCalledWith(["O1"], "jp_warehouse");
    expect(recomputeOrderTotals).toHaveBeenCalledWith("O1");
    expect(syncCustomerOrders).toHaveBeenCalledWith("cust-O1");
  });

  it("syncPackedFromWarehouse_alreadyPackedTracking_notCountedAsUpdated", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    expect(await syncPackedFromWarehouse()).toEqual({ matched: 1, updated: 0 });
  });
});

describe("syncPackedFromWarehouse - matching rows to trackings", () => {
  it("syncPackedFromWarehouse_sharedCodeTwoRows_assignsRowsToOrdersSortedByOrderCode", async () => {
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]));
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]));
    setup({ tabs: { "26.6": [{ E: CODE }, { E: CODE }] }, trks: [b, a] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F1:G1")).toEqual([["Bag", 1000]]);
    expect(valueAt("'26.6'!F2:G2")).toEqual([["Shoe", 2000]]);
  });

  it("syncPackedFromWarehouse_sharedCodeTwoRows_savesEachTrackingsPackRow", async () => {
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]));
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]));
    setup({ tabs: { "26.6": [{ E: CODE, A: "GA", B: "1" }, { E: CODE, A: "GA", B: "2" }] }, trks: [b, a] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates().filter((u) => "packRow" in u.data).map((u) => [u.where.id, u.data.packRow])).toEqual([["ta", 1], ["tb", 2]]);
  });

  it("syncPackedFromWarehouse_sharedCodeOnlyOneRowScanned_writesSharedNoteCountAndGreen", async () => {
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]));
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]));
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [a, b] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!U1:W1")).toEqual([["Mã dùng chung 2 đơn - đã quét 1/2 dòng", "", 2]]);
    expect(rowColor(1)).toBe(GREEN);
  });

  it("syncPackedFromWarehouse_oneTrackingScannedOnTwoRows_warnsDuplicateScanInRed", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]));
    setup({ tabs: { "26.6": [{ E: CODE }, { E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!U2:W2")?.[0][0]).toBe("CẢNH BÁO: mã quét trùng 2 dòng nhưng hệ thống chỉ có 1 đơn - kiểm tra tracking trùng (shop cấp trùng hoặc quét nhầm)");
    expect(rowColor(2)).toBe(RED);
  });

  it("syncPackedFromWarehouse_orphanTrackingRow_writesNothingForThatRow", async () => {
    const t = trk("t1", null);
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F1:G1")).toBeUndefined();
    expect(valueAt("'26.6'!U1:W1")).toBeUndefined();
  });
});

describe("syncPackedFromWarehouse - cartons", () => {
  it("syncPackedFromWarehouse_rowWithBillAndThung_assignsUppercasedCarton", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE, A: "ga", B: "3" }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { cartonId: "carton-GA 3" } });
  });

  it("syncPackedFromWarehouse_sameCartonDifferentCaseOnTwoRows_createsCartonOnce", async () => {
    const a = trk("ta", null, { code: "AAA11111" });
    const b = trk("tb", null, { code: "BBB22222" });
    setup({ tabs: { "26.6": [{ E: "AAA11111", A: "ga", B: "3" }, { E: "BBB22222", A: "GA", B: "3" }] }, trks: [a, b] });
    await syncPackedFromWarehouse();
    expect(db.carton.create).toHaveBeenCalledTimes(1);
  });

  it("syncPackedFromWarehouse_cartonManualTracking_keepsCartonButSavesPackRow", async () => {
    const t = trk("t1", null, { cartonManual: true, cartonId: "manual" });
    setup({ tabs: { "26.6": [{ E: CODE, A: "GA", B: "3" }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { packRow: 1 } });
  });

  it("syncPackedFromWarehouse_matchedTrackingPackedOnOtherDay_correctsPackedAtToRowDay", async () => {
    const t = trk("t1", null, { packedAt: D20, packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE, A: "GA", B: "3" }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates()[0].data.packedAt).toEqual(D26);
  });

  it("syncPackedFromWarehouse_rowWithoutBillAndThung_doesNotTouchCarton", async () => {
    const t = trk("t1", null, { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(db.carton.create).not.toHaveBeenCalled();
    expect(trackingUpdates()).toEqual([]);
  });
});

describe("syncPackedFromWarehouse - stale rows", () => {
  it("syncPackedFromWarehouse_rowNowHoldsDifferentCode_unpacksOldLinkedTracking", async () => {
    setup({ tabs: { "26.6": [{ E: "NEW11111" }] }, candidates: [{ id: "old", code: CODE, orderId: "O9", cartonId: null, packRow: 1, packedAt: D26 }] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates().find((u) => u.where.id === "old")?.data).toMatchObject({ packedAt: null, status: "linked", packRow: null });
  });

  it("syncPackedFromWarehouse_rowCodeErased_clearsSystemCellsAndWhitensRow", async () => {
    setup({ tabs: { "26.6": [{ E: "NEW11111" }, { E: "" }] }, candidates: [{ id: "old", code: CODE, orderId: null, cartonId: null, packRow: 2, packedAt: D26 }] });
    await syncPackedFromWarehouse();
    expect(db.tracking.delete).toHaveBeenCalledWith({ where: { id: "old" } });
    expect(valueAt("'26.6'!F2:G2")).toEqual([["", ""]]);
    expect(valueAt("'26.6'!U2:X2")).toEqual([["", "", "", ""]]);
    expect(rowColor(2)).toBe(WHITE);
  });

  it("syncPackedFromWarehouse_staleClaimOnLockedDay_keepsTracking", async () => {
    setup({ tabs: { "26.6": [{ E: "NEW11111" }] }, locked: [D26], candidates: [{ id: "old", code: CODE, orderId: null, cartonId: null, packRow: 1, packedAt: D26 }] });
    await syncPackedFromWarehouse();
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  it("syncPackedFromWarehouse_rowStillHoldsSameCode_keepsTracking", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [], candidates: [{ id: "keep", code: CODE, orderId: null, cartonId: null, packRow: 1, packedAt: D26 }] });
    await syncPackedFromWarehouse();
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  // packedAt có giờ (vd webhook không gửi tab -> new Date()) nằm sau cutoff, nhưng tab nửa đêm cùng ngày bị reader lọc bỏ -> bị coi là dòng đã xóa.
  it("syncPackedFromWarehouse_recentDaysBoundaryDayPackedAtWithTime_keepsTrackingOfUnscannedTab", async () => {
    setup({ tabs: { "28.6": [{ E: CODE }], "1.7": [{ E: "NEW11111" }] }, trks: [], candidates: [{ id: "keep", code: CODE, orderId: null, cartonId: null, packRow: 1, packedAt: new Date("2026-06-28T10:00:00Z") }] });
    await syncPackedFromWarehouse({ recentDays: 3 });
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  it("syncPackedFromWarehouse_leftoverNameWithoutCode_clearsThatRow", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }, { E: "", F: "Bag" }] }, trks: [] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F2:G2")).toEqual([["", ""]]);
  });

  it("syncPackedFromWarehouse_leftoverNameOnLockedDay_keepsRow", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }, { E: "", F: "Bag" }] }, trks: [], locked: [D26] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F2:G2")).toBeUndefined();
  });

  it("syncPackedFromWarehouse_erasedRowAlsoHasLeftoverName_clearsRowOnlyOnce", async () => {
    setup({ tabs: { "26.6": [{ E: "NEW11111" }, { E: "", F: "Bag" }] }, candidates: [{ id: "old", code: CODE, orderId: null, cartonId: null, packRow: 2, packedAt: D26 }] });
    await syncPackedFromWarehouse();
    expect(writtenValues().filter((d) => d.range === "'26.6'!F2:G2")).toHaveLength(1);
  });

  it("syncPackedFromWarehouse_clearingBlankRowsFails_logsAndContinuesSync", async () => {
    const t = trk("t1", null, { packedAt: null });
    setup({ tabs: { "26.6": [{ E: CODE }, { E: "", F: "Bag" }] }, trks: [t] });
    mValues.mockRejectedValueOnce(new Error("boom"));
    const res = await syncPackedFromWarehouse();
    expect(logError).toHaveBeenCalledWith({ err: "boom" }, "gsheets_clear_blanked_rows_failed");
    expect(res).toEqual({ matched: 1, updated: 1 });
  });
});

describe("syncPackedFromWarehouse - write back", () => {
  it("syncPackedFromWarehouse_khoRenamedSingleRow_keepsNameSavesCustomsNameAndColorsOrange", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE, F: "Leather handbag" }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F1:G1")).toBeUndefined();
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { customsName: "Leather handbag" } });
    expect(rowColor(1)).toBe(ORANGE);
  });

  it("syncPackedFromWarehouse_cellHoldsOldMergedName_overwritesWithOwnItemAndClearsCustomsName", async () => {
    const a = trk("ta", order("OA", [{ name: "Bag", price: 1000 }]), { customsName: "Shoe + Bag" });
    const b = trk("tb", order("OB", [{ name: "Shoe", price: 2000 }]));
    setup({ tabs: { "26.6": [{ E: CODE, F: "Shoe + Bag" }, { E: CODE }] }, trks: [a, b] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!F1:G1")).toEqual([["Bag", 1000]]);
    expect(trackingUpdates()).toContainEqual({ where: { id: "ta" }, data: { customsName: null } });
  });

  it("syncPackedFromWarehouse_lateRowNotResolved_writesLateNoteAndColorsPurple", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1, lateAfterLock: true });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!U1:W1")?.[0][0]).toBe(LATE_NOTE);
    expect(rowColor(1)).toBe(PURPLE);
  });

  it("syncPackedFromWarehouse_lateRowResolved_resetsLateFlagClearsXAndColorsWhite", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1, lateAfterLock: true });
    setup({ tabs: { "26.6": [{ E: CODE, X: "TRUE" }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(trackingUpdates()).toContainEqual({ where: { id: "t1" }, data: { lateAfterLock: false } });
    expect(valueAt("'26.6'!X1")).toEqual([[""]]);
    expect(rowColor(1)).toBe(WHITE);
  });

  it("syncPackedFromWarehouse_orderNeedsCheck_writesCheckNoteLinkAndColorsYellow", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000, url: "https://shop/1" }], { needsCheck: true, checkNote: "Gia cố" }), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!U1:W1")).toEqual([["Gia cố", "https://shop/1", 1]]);
    expect(rowColor(1)).toBe(YELLOW);
  });

  it("syncPackedFromWarehouse_coloredRow_addsCheckboxOnX", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }], { needsCheck: true }), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    await syncPackedFromWarehouse();
    expect(formatReqs()).toContainEqual({ setDataValidation: { range: { sheetId: 100, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 23, endColumnIndex: 24 }, rule: { condition: { type: "BOOLEAN" }, strict: true } } });
  });

  it.each([
    { name: "locked", locked: [D26], expected: true },
    { name: "open", locked: [], expected: false },
  ])("syncPackedFromWarehouse_dayLockCell_$name_writesZ1As$expected", async ({ locked, expected }) => {
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [trk("t1", null, { packRow: 1 })], locked });
    await syncPackedFromWarehouse();
    expect(valueAt("'26.6'!Y1")).toEqual([["Đã nộp hải quan (tick khi xong)"]]);
    expect(valueAt("'26.6'!Z1")).toEqual([[expected]]);
  });

  it("syncPackedFromWarehouse_dayLockCell_addsCheckboxOnZ1", async () => {
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [trk("t1", null, { packRow: 1 })] });
    await syncPackedFromWarehouse();
    expect(formatReqs()).toContainEqual({ setDataValidation: { range: { sheetId: 100, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 25, endColumnIndex: 26 }, rule: { condition: { type: "BOOLEAN" }, strict: true } } });
  });

  it("syncPackedFromWarehouse_writeBackFails_logsErrorAndStillReturnsCounts", async () => {
    const t = trk("t1", order("O1", [{ name: "Bag", price: 1000 }]), { packRow: 1 });
    setup({ tabs: { "26.6": [{ E: CODE }] }, trks: [t] });
    mValues.mockRejectedValueOnce(new Error("GSHEET_API 403"));
    expect(await syncPackedFromWarehouse()).toEqual({ matched: 1, updated: 0 });
    expect(logError).toHaveBeenCalledWith({ err: "GSHEET_API 403" }, "gsheets_write_invoice_to_warehouse_failed");
  });
});

describe("setDayLockFromTab", () => {
  it("setDayLockFromTab_nonDateTab_doesNothing", async () => {
    await setDayLockFromTab("TRANG MẪU", true);
    expect(db.packDayLock.upsert).not.toHaveBeenCalled();
    expect(db.packDayLock.deleteMany).not.toHaveBeenCalled();
  });

  it("setDayLockFromTab_lockedTrue_upsertsLockForTabDay", async () => {
    await setDayLockFromTab("26.6", true);
    expect(db.packDayLock.upsert).toHaveBeenCalledWith({ where: { date: D26 }, update: {}, create: { date: D26 } });
  });

  it("setDayLockFromTab_lockedFalse_deletesLockForTabDay", async () => {
    await setDayLockFromTab("26.6", false);
    expect(db.packDayLock.deleteMany).toHaveBeenCalledWith({ where: { date: D26 } });
  });
});

describe("clearWarehouseRow", () => {
  it.each([
    { name: "no packedAt", packedAt: null, row: 3 },
    { name: "no row", packedAt: D26, row: null },
  ])("clearWarehouseRow_$name_doesNothing", async ({ packedAt, row }) => {
    db.appConfig.findUnique.mockResolvedValue({ value: "1234567890abcdefghijXYZ" });
    await clearWarehouseRow(packedAt, row);
    expect(mList).not.toHaveBeenCalled();
  });

  it("clearWarehouseRow_noWarehouseSheetConfigured_doesNothing", async () => {
    db.appConfig.findUnique.mockResolvedValue(null);
    await clearWarehouseRow(D26, 3);
    expect(mValues).not.toHaveBeenCalled();
  });

  it("clearWarehouseRow_noTabForThatDay_doesNothing", async () => {
    setup({ tabs: { "25.6": [] } });
    await clearWarehouseRow(D26, 3);
    expect(mValues).not.toHaveBeenCalled();
  });

  it("clearWarehouseRow_tabFound_clearsSystemCellsOfRow", async () => {
    setup({ tabs: { "TRANG MẪU": [], "26.6": [] } });
    await clearWarehouseRow(D26, 3);
    expect(mValues).toHaveBeenCalledWith("1234567890abcdefghijXYZ", [
      { range: "'26.6'!F3:G3", values: [["", ""]] },
      { range: "'26.6'!U3:X3", values: [["", "", "", ""]] },
    ]);
  });

  it("clearWarehouseRow_tabFound_whitensRowOnThatTabsSheetId", async () => {
    setup({ tabs: { "TRANG MẪU": [], "26.6": [] } });
    await clearWarehouseRow(D26, 3);
    expect(rowColor(3, 101)).toBe(WHITE);
  });

  it("clearWarehouseRow_sheetsApiFails_logsErrorWithoutThrowing", async () => {
    setup({ tabs: { "26.6": [] } });
    mList.mockRejectedValue(new Error("GSHEET_API 500"));
    await expect(clearWarehouseRow(D26, 3)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith({ err: "GSHEET_API 500" }, "gsheets_clear_warehouse_row_failed");
  });
});
