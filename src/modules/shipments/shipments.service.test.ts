import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    tracking: { findMany: vi.fn(), updateMany: vi.fn() },
    taxRowNote: { findMany: vi.fn(), createMany: vi.fn() },
    orderItem: { findMany: vi.fn() },
  },
}));
vi.mock("../../integrations/minio/documentStorage.js", () => ({}));
vi.mock("../sheets/invoiceTaxSheet.service.js", () => ({}));

import { matchTaxRows, parseMonth } from "./shipments.service.js";
import { prisma } from "../../infrastructure/prisma.js";

const mp = prisma as any;

const order = (code: string, itemName: string) => ({ code, nick: "nk", customer: { name: "Khách" }, items: [{ name: itemName, url: "https://x/1" }] });

beforeEach(() => {
  vi.clearAllMocks();
  mp.tracking.findMany.mockResolvedValue([]);
  mp.taxRowNote.findMany.mockResolvedValue([]);
  mp.orderItem.findMany.mockResolvedValue([]);
});

describe("matchTaxRows", () => {
  it("matchTaxRows_noRows_returnsEmptyWithoutQuerying", async () => {
    expect(await matchTaxRows([], { persist: true })).toEqual([]);
    expect(mp.tracking.findMany).not.toHaveBeenCalled();
  });

  it("matchTaxRows_persistFalse_neverWritesNeedsTaxOrNoteKeys", async () => {
    mp.tracking.findMany.mockResolvedValue([{ id: "t1", code: "T1", needsTax: false, taxCollected: false, packedAt: null, order: order("OD1", "Áo") }]);
    mp.orderItem.findMany.mockResolvedValue([{ name: "Quần jean", order: order("OD2", "Quần jean") }]);
    const rows = await matchTaxRows([
      { trackingCode: "T1", itemName: "Áo", price: 1, bill: "GE" },
      { trackingCode: null, itemName: "Quần jean", price: 2, bill: "GE" },
    ], { persist: false });
    expect(rows.map((r) => r.matchedBy)).toEqual(["tracking", "name"]);
    expect(mp.tracking.updateMany).not.toHaveBeenCalled();
    expect(mp.taxRowNote.createMany).not.toHaveBeenCalled();
  });

  it("matchTaxRows_persistTrue_registersNoteKeyForNewNameMatch", async () => {
    mp.orderItem.findMany.mockResolvedValue([{ name: "Quần jean", order: order("OD2", "Quần jean") }]);
    await matchTaxRows([{ trackingCode: null, itemName: "Quần jean", price: 2, bill: "GE" }], { persist: true });
    expect(mp.taxRowNote.createMany).toHaveBeenCalledWith({ data: [{ trackingCode: "name:GE:OD2:Quần jean", note: "", taxCollected: false }], skipDuplicates: true });
  });

  it("matchTaxRows_orderAlreadyClaimedByTracking_isNotNameMatchedAgain", async () => {
    mp.tracking.findMany.mockResolvedValue([{ id: "t1", code: "T1", needsTax: true, taxCollected: false, packedAt: null, order: order("OD1", "Áo thun") }]);
    mp.orderItem.findMany.mockResolvedValue([{ name: "Áo thun", order: order("OD1", "Áo thun") }]);
    const rows = await matchTaxRows([
      { trackingCode: "T1", itemName: "Áo thun", price: 1, bill: null },
      { trackingCode: null, itemName: "Áo thun", price: 1, bill: null },
    ], { persist: true });
    expect(rows[1]).toMatchObject({ unmatched: true, orderCode: null });
  });

  it("matchTaxRows_unknownTrackingCode_returnsUnmatchedRowWithSavedNote", async () => {
    mp.taxRowNote.findMany.mockResolvedValue([{ trackingCode: "TX", note: "đã hỏi kho" }]);
    const rows = await matchTaxRows([{ trackingCode: "TX", itemName: "x", price: null, bill: null }], { persist: true });
    expect(rows).toEqual([expect.objectContaining({ trackingCode: "TX", unmatched: true, note: "đã hỏi kho" })]);
  });
});

describe("parseMonth", () => {
  it("parseMonth_validMonth_returnsVnRange", () => {
    expect(parseMonth("2026-12")).toEqual({ start: new Date("2026-12-01T00:00:00+07:00"), end: new Date("2027-01-01T00:00:00+07:00") });
  });

  it("parseMonth_invalid_returnsNull", () => {
    expect(parseMonth("2026-1")).toBeNull();
    expect(parseMonth(undefined)).toBeNull();
  });
});
