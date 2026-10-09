import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    carton: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    tracking: { update: vi.fn(), delete: vi.fn(), findMany: vi.fn() },
    trackingLog: { deleteMany: vi.fn() },
    appConfig: { findUnique: vi.fn() },
  },
}));
vi.mock("../cartons/carton.service.js", () => ({ deleteCartonIfEmpty: vi.fn() }));
vi.mock("../orders/order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));

import { prisma } from "../../infrastructure/prisma.js";
import { deleteCartonIfEmpty } from "../cartons/carton.service.js";
import { recomputeOrderTotals } from "../orders/order.totals.js";
import {
  WHITE, blankRowFormatRequests, blankRowValueData, checkNoteOf, itemForTracking, itemsForRow, itemsNameAndPrice, linkOf,
  isWarehouseReadonly, looksLikeOldMerge, resolveCartonId, uniqueOrders, unpackStaleTracking, type TrackingWithOrder,
} from "./warehouseSheet.shared.js";

const db = prisma as unknown as {
  carton: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  tracking: { update: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  trackingLog: { deleteMany: ReturnType<typeof vi.fn> };
  appConfig: { findUnique: ReturnType<typeof vi.fn> };
};

type Ord = NonNullable<TrackingWithOrder["order"]>;
type Item = Ord["items"][number];

function item(o: { name: string; qty?: number; price?: number; ship?: number | null; url?: string | null }): Item {
  return {
    id: `i-${o.name}`, name: o.name, qty: o.qty ?? 1, unitPriceJpy: new Prisma.Decimal(o.price ?? 0),
    shipJpy: o.ship == null ? null : new Prisma.Decimal(o.ship), url: o.url ?? null,
  } as unknown as Item;
}
function order(id: string, items: Item[], extra: Partial<Ord> = {}): Ord {
  return { id, code: id, items, trackings: [], needsCheck: false, checkNote: null, ...extra } as unknown as Ord;
}
// Gắn tracking vào đơn đúng thứ tự (index tracking <-> index item).
function trackingsOf(ord: Ord, ids: string[]): TrackingWithOrder[] {
  const ts = ids.map((id) => ({ id, code: "CODE12345", order: ord }) as unknown as TrackingWithOrder);
  (ord as unknown as { trackings: unknown[] }).trackings = ts;
  return ts;
}

beforeEach(() => vi.clearAllMocks());

describe("uniqueOrders", () => {
  it("uniqueOrders_duplicateAndNullOrders_returnsDistinctOrdersInFirstSeenOrder", () => {
    const a = order("A", []), b = order("B", []);
    const group = [{ order: b }, { order: null }, { order: a }, { order: b }] as unknown as TrackingWithOrder[];
    expect(uniqueOrders(group).map((o) => o.id)).toEqual(["B", "A"]);
  });
});

describe("itemForTracking", () => {
  it("itemForTracking_trackingWithoutOrder_returnsUndefined", () => {
    expect(itemForTracking({ id: "t1", order: null } as unknown as TrackingWithOrder)).toBeUndefined();
  });

  it("itemForTracking_secondTrackingOfOrder_returnsSecondItem", () => {
    const ord = order("A", [item({ name: "Bag" }), item({ name: "Shoe" })]);
    const [, t2] = trackingsOf(ord, ["t1", "t2"]);
    expect(itemForTracking(t2)?.name).toBe("Shoe");
  });

  it("itemForTracking_trackingNotListedInOrder_returnsUndefined", () => {
    const ord = order("A", [item({ name: "Bag" })]);
    trackingsOf(ord, ["t1"]);
    expect(itemForTracking({ id: "zz", order: ord } as unknown as TrackingWithOrder)).toBeUndefined();
  });

  it("itemForTracking_moreTrackingsThanItems_returnsUndefinedForExtraTracking", () => {
    const ord = order("A", [item({ name: "Bag" })]);
    const [, t2] = trackingsOf(ord, ["t1", "t2"]);
    expect(itemForTracking(t2)).toBeUndefined();
  });
});

describe("itemsForRow", () => {
  it("itemsForRow_singleWithPositionalItem_returnsOnlyThatItem", () => {
    const ord = order("A", [item({ name: "Bag" }), item({ name: "Shoe" })]);
    const [t1] = trackingsOf(ord, ["t1", "t2"]);
    expect(itemsForRow(t1, [ord]).map((i) => i.name)).toEqual(["Bag"]);
  });

  it("itemsForRow_singleWithoutPositionalItem_returnsAllItemsOfItsOrder", () => {
    const ord = order("A", [item({ name: "Bag" }), item({ name: "Shoe" })]);
    const single = { id: "other", order: ord } as unknown as TrackingWithOrder;
    trackingsOf(ord, ["t1"]);
    expect(itemsForRow(single, [ord]).map((i) => i.name)).toEqual(["Bag", "Shoe"]);
  });

  it("itemsForRow_singleOrphan_returnsEmpty", () => {
    expect(itemsForRow({ id: "t1", order: null } as unknown as TrackingWithOrder, [])).toEqual([]);
  });

  it("itemsForRow_noSingle_returnsItemsOfAllOrdersFlattened", () => {
    const a = order("A", [item({ name: "Bag" })]), b = order("B", [item({ name: "Shoe" }), item({ name: "Hat" })]);
    expect(itemsForRow(undefined, [a, b]).map((i) => i.name)).toEqual(["Bag", "Shoe", "Hat"]);
  });
});

describe("itemsNameAndPrice", () => {
  it("itemsNameAndPrice_multipleItems_joinsNamesAndSumsQtyTimesPricePlusShip", () => {
    const r = itemsNameAndPrice([item({ name: "Bag", qty: 2, price: 1500, ship: 300 }), item({ name: "Shoe", qty: 1, price: 800, ship: null })]);
    expect(r).toEqual({ name: "Bag + Shoe", price: 4100 });
  });

  it("itemsNameAndPrice_emptyList_returnsEmptyNameAndZero", () => {
    expect(itemsNameAndPrice([])).toEqual({ name: "", price: 0 });
  });
});

describe("looksLikeOldMerge", () => {
  const a = order("A", [item({ name: "Bag" })]), b = order("B", [item({ name: "Shoe" })]);
  const fullGroup = [{ order: a }, { order: b }] as unknown as TrackingWithOrder[];

  it.each([
    { name: "same order", sheet: "Bag + Shoe", expected: true },
    { name: "reversed order", sheet: "Shoe + Bag", expected: true },
    { name: "extra spaces", sheet: " Shoe  +  Bag ", expected: true },
    { name: "one name only", sheet: "Bag", expected: false },
    { name: "extra name", sheet: "Bag + Shoe + Hat", expected: false },
    { name: "kho renamed", sheet: "Handbag + Shoe", expected: false },
  ])("looksLikeOldMerge_sheetName_$name_returns$expected", ({ sheet, expected }) => {
    expect(looksLikeOldMerge(fullGroup, sheet)).toBe(expected);
  });

  it("looksLikeOldMerge_groupWithSingleItemName_returnsFalse", () => {
    expect(looksLikeOldMerge([{ order: a }] as unknown as TrackingWithOrder[], "Bag")).toBe(false);
  });
});

describe("checkNoteOf", () => {
  it("checkNoteOf_mixedOrders_joinsTrimmedNotesWithDefaultForBlankAndSkipsUnflagged", () => {
    const orders = [
      order("A", [], { needsCheck: true, checkNote: "  Gia cố góc  " }),
      order("B", [], { needsCheck: false, checkNote: "ignored" }),
      order("C", [], { needsCheck: true, checkNote: "   " }),
      order("D", [], { needsCheck: true, checkNote: null }),
    ];
    expect(checkNoteOf(orders)).toBe("Gia cố góc | Mở hàng / gia cố | Mở hàng / gia cố");
  });

  it("checkNoteOf_noFlaggedOrders_returnsEmptyString", () => {
    expect(checkNoteOf([order("A", [])])).toBe("");
  });
});

describe("linkOf", () => {
  it("linkOf_duplicateAndMissingUrls_returnsDistinctUrlsSpaceSeparated", () => {
    const items = [item({ name: "a", url: "https://x/1" }), item({ name: "b", url: null }), item({ name: "c", url: "" }), item({ name: "d", url: "https://x/1" }), item({ name: "e", url: "https://x/2" })];
    expect(linkOf(items)).toBe("https://x/1 https://x/2");
  });
});

describe("blankRowValueData / blankRowFormatRequests", () => {
  it("blankRowValueData_row7_clearsOnlyFGAndUToX", () => {
    expect(blankRowValueData("26.6", 7)).toEqual([
      { range: "'26.6'!F7:G7", values: [["", ""]] },
      { range: "'26.6'!U7:X7", values: [["", "", "", ""]] },
    ]);
  });

  it("blankRowFormatRequests_row7_whitensWholeRowAndClearsXValidation", () => {
    expect(blankRowFormatRequests(42, 7)).toEqual([
      { repeatCell: { range: { sheetId: 42, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 0, endColumnIndex: 24 }, cell: { userEnteredFormat: { backgroundColor: WHITE } }, fields: "userEnteredFormat.backgroundColor" } },
      { setDataValidation: { range: { sheetId: 42, startRowIndex: 6, endRowIndex: 7, startColumnIndex: 23, endColumnIndex: 24 } } },
    ]);
  });
});

describe("resolveCartonId", () => {
  const day = new Date("2026-06-26T00:00:00Z");

  it("resolveCartonId_blankBillAndThung_returnsNullWithoutCreating", async () => {
    expect(await resolveCartonId("", "  ", day)).toBeNull();
    expect(db.carton.create).not.toHaveBeenCalled();
  });

  it("resolveCartonId_existingCartonSameDay_returnsItsIdWithoutCreating", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old" });
    expect(await resolveCartonId("ga", "3", day)).toBe("c-old");
    expect(db.carton.create).not.toHaveBeenCalled();
  });

  it("resolveCartonId_lowercaseBill_looksUpUppercasedCode", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old" });
    await resolveCartonId("ga", "3", day);
    expect(db.carton.findFirst.mock.calls[0][0].where).toEqual({ code: "GA 3", packedDate: day });
  });

  it("resolveCartonId_noCartonYet_createsUppercasedCartonForDay", async () => {
    db.carton.findFirst.mockResolvedValue(null);
    db.carton.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({ id: data.id }));
    const id = await resolveCartonId("ga", "", day);
    const data = db.carton.create.mock.calls[0][0].data;
    expect(data.code).toBe("GA");
    expect(data.packedDate).toBe(day);
    expect(data.route).toBe("air");
    expect(data.declaredWeightKg).toBeNull();
    expect(id).toBe(data.id);
  });

  it("resolveCartonId_noCartonYetWithSeaRouteAndKg_createsWithRouteAndDeclaredWeight", async () => {
    db.carton.findFirst.mockResolvedValue(null);
    db.carton.create.mockImplementation(async ({ data }: { data: { id: string } }) => ({ id: data.id }));
    await resolveCartonId("ga", "3", day, "sea", 12.6);
    expect(db.carton.create.mock.calls[0][0].data).toMatchObject({ code: "GA 3", route: "sea", declaredWeightKg: 12.6 });
  });

  it("resolveCartonId_existingCartonWithoutDeclaredKg_fillsDeclaredWeight", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old", route: "air", declaredWeightKg: null });
    db.carton.update.mockResolvedValue({ id: "c-old", route: "air", declaredWeightKg: 12.6 });
    expect(await resolveCartonId("ga", "3", day, "air", 12.6)).toBe("c-old");
    expect(db.carton.update).toHaveBeenCalledWith({ where: { id: "c-old" }, data: { declaredWeightKg: 12.6 } });
  });

  it("resolveCartonId_existingCartonWithDeclaredKg_doesNotOverwriteManualWeight", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old", route: "air", declaredWeightKg: 15 });
    await resolveCartonId("ga", "3", day, "air", 12.6);
    expect(db.carton.update).not.toHaveBeenCalled();
  });

  it("resolveCartonId_existingCartonRouteChanged_updatesRouteAndRecomputesItsOrders", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old", route: "air", declaredWeightKg: 10 });
    db.carton.update.mockResolvedValue({ id: "c-old", route: "sea", declaredWeightKg: 10 });
    db.tracking.findMany.mockResolvedValue([{ orderId: "o1" }, { orderId: "o2" }, { orderId: "o1" }]);
    await resolveCartonId("ga", "3", day, "sea");
    expect(db.carton.update).toHaveBeenCalledWith({ where: { id: "c-old" }, data: { route: "sea" } });
    expect(db.tracking.findMany).toHaveBeenCalledWith({ where: { cartonId: "c-old", orderId: { not: null } }, select: { orderId: true } });
    expect(vi.mocked(recomputeOrderTotals).mock.calls.map((c) => c[0])).toEqual(["o1", "o2"]);
  });

  it("resolveCartonId_weightMissingAndRouteChanged_fillsWeightAndUpdatesRouteSameRun", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old", route: "air", declaredWeightKg: null });
    db.carton.update
      .mockResolvedValueOnce({ id: "c-old", route: "air", declaredWeightKg: 12.6 })
      .mockResolvedValueOnce({ id: "c-old", route: "sea", declaredWeightKg: 12.6 });
    db.tracking.findMany.mockResolvedValue([{ orderId: "o1" }]);
    await resolveCartonId("ga", "3", day, "sea", 12.6);
    expect(db.carton.update).toHaveBeenNthCalledWith(1, { where: { id: "c-old" }, data: { declaredWeightKg: 12.6 } });
    expect(db.carton.update).toHaveBeenNthCalledWith(2, { where: { id: "c-old" }, data: { route: "sea" } });
    expect(recomputeOrderTotals).toHaveBeenCalledWith("o1");
  });

  it("resolveCartonId_existingCartonSameRoute_noUpdateNoRecompute", async () => {
    db.carton.findFirst.mockResolvedValue({ id: "c-old", route: "sea", declaredWeightKg: 10 });
    await resolveCartonId("ga", "3", day, "sea");
    expect(db.carton.update).not.toHaveBeenCalled();
    expect(recomputeOrderTotals).not.toHaveBeenCalled();
  });
});

describe("isWarehouseReadonly", () => {
  it.each([
    ["true", true],
    ["false", false],
    ["TRUE", false],
  ])("isWarehouseReadonly_configValue_%s_returns%s", async (value, expected) => {
    db.appConfig.findUnique.mockResolvedValue({ key: "warehouse_sheet_readonly", value });
    expect(await isWarehouseReadonly()).toBe(expected);
    expect(db.appConfig.findUnique).toHaveBeenCalledWith({ where: { key: "warehouse_sheet_readonly" } });
  });

  it("isWarehouseReadonly_noConfig_returnsFalse", async () => {
    db.appConfig.findUnique.mockResolvedValue(null);
    expect(await isWarehouseReadonly()).toBe(false);
  });
});

describe("unpackStaleTracking", () => {
  it("unpackStaleTracking_linkedTracking_resetsPackingFieldsWithoutDeleting", async () => {
    await unpackStaleTracking({ id: "t1", orderId: "o1", cartonId: "c1" });
    expect(db.tracking.update).toHaveBeenCalledWith({
      where: { id: "t1" },
      data: { packedAt: null, cartonId: null, cartonManual: false, vnWeightKg: null, vnTrackingCode: null, status: "linked", lateAfterLock: false, packRow: null },
    });
    expect(db.tracking.delete).not.toHaveBeenCalled();
  });

  it("unpackStaleTracking_orphanTracking_deletesLogsAndTracking", async () => {
    await unpackStaleTracking({ id: "t1", orderId: null, cartonId: null });
    expect(db.trackingLog.deleteMany).toHaveBeenCalledWith({ where: { trackingId: "t1" } });
    expect(db.tracking.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(db.tracking.update).not.toHaveBeenCalled();
  });

  it("unpackStaleTracking_anyTracking_asksToDeleteItsCartonIfEmpty", async () => {
    await unpackStaleTracking({ id: "t1", orderId: "o1", cartonId: "c9" });
    expect(deleteCartonIfEmpty).toHaveBeenCalledWith("c9");
  });
});
