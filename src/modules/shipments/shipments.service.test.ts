import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    tracking: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    taxRowNote: { findMany: vi.fn(), createMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    orderItem: { findMany: vi.fn() },
    appConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    carton: { findMany: vi.fn() },
    billInvoiceStatus: { findMany: vi.fn(), upsert: vi.fn() },
    document: { create: vi.fn(), findUnique: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});
vi.mock("../../integrations/minio/documentStorage.js", () => ({ getObjectStream: vi.fn(), putObjectFromFile: vi.fn(), removeObjectQuietly: vi.fn() }));
vi.mock("../sheets/invoiceTaxSheet.service.js", () => ({ readInvoiceTaxRows: vi.fn(), readInvoiceTaxRowsFromExcel: vi.fn() }));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));

import {
  matchTaxRows, parseMonth, getTaxConfig, setTaxConfig, listTaxRows, scanTaxFile, setTaxRowNote, taxAudit,
  setTaxAuditDismissed, invoiceChecklist, setInvoiceDone, uploadDocument, openDocument,
} from "./shipments.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { getObjectStream, putObjectFromFile } from "../../integrations/minio/documentStorage.js";
import { readInvoiceTaxRows, readInvoiceTaxRowsFromExcel } from "../sheets/invoiceTaxSheet.service.js";

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

const SHEET_URL = "https://docs.google.com/spreadsheets/d/abcDEF123_-xyz/edit";
const actor = { id: "u1", requestId: "r1" };

describe("getTaxConfig / setTaxConfig", () => {
  it("getTaxConfig_noConfig_returnsEmptyUrlAndNullId", async () => {
    mp.appConfig.findUnique.mockResolvedValue(null);
    expect(await getTaxConfig()).toEqual({ sheetUrl: "", sheetId: null });
  });

  it("setTaxConfig_invalidUrl_throws400BadUrlWithoutSaving", async () => {
    await expect(setTaxConfig("https://example.com/x", actor)).rejects.toMatchObject({ status: 400, code: "BAD_URL" });
    expect(mp.appConfig.upsert).not.toHaveBeenCalled();
  });

  it("setTaxConfig_validUrlWithSpaces_savesTrimmedAndReturnsSheetId", async () => {
    const r = await setTaxConfig(`  ${SHEET_URL} `, actor);
    expect(r).toEqual({ sheetUrl: SHEET_URL, sheetId: "abcDEF123_-xyz" });
    expect(mp.appConfig.upsert.mock.calls[0][0].update).toEqual({ value: SHEET_URL });
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", action: "shipments.tax_config_set", requestId: "r1" });
  });

  it("setTaxConfig_null_clearsConfig", async () => {
    const r = await setTaxConfig(null, actor);
    expect(r).toEqual({ sheetUrl: "", sheetId: null });
    expect(mp.appConfig.upsert.mock.calls[0][0].update).toEqual({ value: "" });
  });
});

describe("matchTaxRows (gaps)", () => {
  it("matchTaxRows_persistTrue_flagsOnlyTrackingsNotYetNeedsTax", async () => {
    mp.tracking.findMany.mockResolvedValue([
      { id: "t1", code: "T1", needsTax: false, taxCollected: false, packedAt: null, order: order("OD1", "A") },
      { id: "t2", code: "T2", needsTax: true, taxCollected: false, packedAt: null, order: order("OD2", "B") },
    ]);
    await matchTaxRows([{ trackingCode: "T1", itemName: "A", price: 1, bill: null }, { trackingCode: "T2", itemName: "B", price: 1, bill: null }], { persist: true });
    expect(mp.tracking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { needsTax: true } });
  });

  it("matchTaxRows_trackingMatch_mapsOrderInfoPurchaseUrlAndIsoPackedAt", async () => {
    mp.tracking.findMany.mockResolvedValue([
      { id: "t1", code: "T1", needsTax: true, taxCollected: true, packedAt: new Date("2026-03-04T05:00:00.000Z"), order: order("OD1", "Áo") },
    ]);
    const [r] = await matchTaxRows([{ trackingCode: "T1", itemName: "Áo", price: 900, bill: "GE" }], { persist: false });
    expect(r).toMatchObject({
      trackingId: "t1", orderCode: "OD1", customerName: "Khách", nick: "nk", taxCollected: true, unmatched: false,
      purchaseUrl: "https://x/1", packedAt: "2026-03-04T05:00:00.000Z", priceJpy: 900, bill: "GE", matchedBy: "tracking",
    });
  });

  it("matchTaxRows_nameNoExactButSimilar_returnsUnmatchedWithSuggestionPercent", async () => {
    mp.orderItem.findMany.mockResolvedValue([{ name: "Nike Air Max 90", order: order("OD5", "Nike Air Max 90") }]);
    const [r] = await matchTaxRows([{ trackingCode: null, itemName: "Nike Air Max 95", price: 1, bill: null }], { persist: false });
    expect(r.unmatched).toBe(true);
    expect(r.suggestion).toMatchObject({ orderCode: "OD5", customerName: "Khách", nick: "nk" });
    expect(r.suggestion!.similarity).toBeGreaterThanOrEqual(50);
  });

  it("matchTaxRows_twoNameRowsSameOrder_secondRowNotMatchedAgain", async () => {
    mp.orderItem.findMany.mockResolvedValue([{ name: "Quần jean", order: order("OD2", "Quần jean") }]);
    const rows = await matchTaxRows([
      { trackingCode: null, itemName: "Quần jean", price: 1, bill: null },
      { trackingCode: null, itemName: "Quần jean", price: 1, bill: null },
    ], { persist: false });
    expect(rows.map((r) => r.orderCode)).toEqual(["OD2", null]);
  });

  it("matchTaxRows_nameMatchWithSavedNote_appliesNoteAndCollectedAndSkipsRegistration", async () => {
    mp.orderItem.findMany.mockResolvedValue([{ name: "Quần jean", order: order("OD2", "Quần jean") }]);
    mp.taxRowNote.findMany.mockImplementation(async (a: any) =>
      a.where.trackingCode.in.includes("name:GE:OD2:Quần jean") ? [{ trackingCode: "name:GE:OD2:Quần jean", note: "đã thu", taxCollected: true }] : []);
    const [r] = await matchTaxRows([{ trackingCode: null, itemName: "Quần jean", price: 1, bill: "GE" }], { persist: true });
    expect(r).toMatchObject({ note: "đã thu", taxCollected: true });
    expect(mp.taxRowNote.createMany).not.toHaveBeenCalled();
  });
});

describe("listTaxRows", () => {
  it("listTaxRows_noSheetConfigured_skipsSheetReadAndReturnsExtraNeedsTaxRows", async () => {
    mp.appConfig.findUnique.mockResolvedValue(null);
    mp.tracking.findMany.mockResolvedValue([{
      id: "t3", code: "T3", taxCollected: false, packedAt: null, carton: { code: "GE 2" },
      order: { code: "OD3", nick: null, customer: { name: "K" }, items: [
        { name: "Áo", url: null, qty: 2, unitPriceJpy: "1000", shipJpy: "300" },
        { name: "Mũ", url: "https://m", qty: 1, unitPriceJpy: "500", shipJpy: null },
      ] },
    }]);
    const rows = await listTaxRows({ persist: false });
    expect(readInvoiceTaxRows).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ trackingId: "t3", itemName: "Áo + Mũ", priceJpy: 2800, bill: "GE", orderCode: "OD3", matchedBy: "tracking", unmatched: false })]);
  });

  it("listTaxRows_trackingAlreadyShownFromSheet_excludedFromExtraQuery", async () => {
    mp.appConfig.findUnique.mockResolvedValue({ value: SHEET_URL });
    (readInvoiceTaxRows as ReturnType<typeof vi.fn>).mockResolvedValue([{ trackingCode: "T1", itemName: "A", price: 1, bill: null }]);
    mp.tracking.findMany
      .mockResolvedValueOnce([{ id: "t1", code: "T1", needsTax: true, taxCollected: false, packedAt: null, order: order("OD1", "A") }])
      .mockResolvedValueOnce([]);
    await listTaxRows({ persist: false });
    expect(mp.tracking.findMany.mock.calls[1][0].where.id).toEqual({ notIn: ["t1"] });
  });

  it("listTaxRows_extraTrackingWithoutItems_usesPlaceholderNameAndNullPrice", async () => {
    mp.appConfig.findUnique.mockResolvedValue(null);
    mp.tracking.findMany.mockResolvedValue([{ id: "t4", code: "T4", taxCollected: false, packedAt: null, carton: null, order: { code: "OD4", nick: null, customer: null, items: [] } }]);
    const [r] = await listTaxRows({ persist: false });
    expect(r).toMatchObject({ itemName: "(chưa quét chi tiết)", priceJpy: null, purchaseUrl: null, bill: null });
  });
});

describe("scanTaxFile", () => {
  it("scanTaxFile_readableExcel_matchesWithPersist", async () => {
    (readInvoiceTaxRowsFromExcel as ReturnType<typeof vi.fn>).mockResolvedValue([{ trackingCode: "T1", itemName: "A", price: 1, bill: null }]);
    mp.tracking.findMany.mockResolvedValue([{ id: "t1", code: "T1", needsTax: false, taxCollected: false, packedAt: null, order: order("OD1", "A") }]);
    await scanTaxFile(Buffer.from("x"));
    expect(mp.tracking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { needsTax: true } });
  });
});

describe("setTaxRowNote (gaps)", () => {
  it("setTaxRowNote_bothEmptyAndNoExisting_returnsClearedWithoutDelete", async () => {
    mp.taxRowNote.findUnique.mockResolvedValue(null);
    const r = await setTaxRowNote("T1", { note: "  " }, actor);
    expect(r).toEqual({ trackingCode: "T1", note: null, taxCollected: false });
    expect(mp.taxRowNote.delete).not.toHaveBeenCalled();
    expect(mp.taxRowNote.upsert).not.toHaveBeenCalled();
  });

  it("setTaxRowNote_newNote_upsertsTrimmedNoteWithUpdatedBy", async () => {
    mp.taxRowNote.findUnique.mockResolvedValue(null);
    mp.taxRowNote.upsert.mockResolvedValue({ trackingCode: "T1", note: "hỏi kho", taxCollected: false });
    const r = await setTaxRowNote("T1", { note: " hỏi kho " }, actor);
    expect(mp.taxRowNote.upsert.mock.calls[0][0].create).toEqual({ trackingCode: "T1", note: "hỏi kho", taxCollected: false, updatedBy: "u1" });
    expect(r).toEqual({ trackingCode: "T1", note: "hỏi kho", taxCollected: false });
  });

  it("setTaxRowNote_collectedWithEmptyNote_returnsNullNote", async () => {
    mp.taxRowNote.findUnique.mockResolvedValue(null);
    mp.taxRowNote.upsert.mockResolvedValue({ trackingCode: "T1", note: "", taxCollected: true });
    const r = await setTaxRowNote("T1", { taxCollected: true }, actor);
    expect(r).toEqual({ trackingCode: "T1", note: null, taxCollected: true });
  });
});

describe("taxAudit", () => {
  it("taxAudit_mixedTrackings_countsDeclaredAndListsUndeclaredNotDismissed", async () => {
    mp.tracking.findMany.mockResolvedValue([
      { id: "a", code: "A", packedAt: null, needsTax: true, taxCollected: true, taxAuditDismissed: false, order: null },
      { id: "b", code: "B", packedAt: null, needsTax: true, taxCollected: false, taxAuditDismissed: false, order: null },
      { id: "c", code: "C", packedAt: new Date("2026-03-02T00:00:00.000Z"), needsTax: false, taxCollected: false, taxAuditDismissed: false, order: { code: "OD", nick: "n", customer: { name: "K" } } },
      { id: "d", code: "D", packedAt: null, needsTax: false, taxCollected: false, taxAuditDismissed: true, order: null },
    ]);
    const r = await taxAudit({ start: new Date(0), end: new Date(1) });
    expect(r).toEqual({
      total: 4, declaredCollected: 1, declaredPending: 1,
      notDeclared: [{ trackingId: "c", trackingCode: "C", orderCode: "OD", customerName: "K", nick: "n", packedAt: "2026-03-02T00:00:00.000Z" }],
    });
  });

  it("setTaxAuditDismissed_givenFlag_updatesTracking", async () => {
    expect(await setTaxAuditDismissed("t1", true)).toEqual({ ok: true });
    expect(mp.tracking.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { taxAuditDismissed: true } });
  });
});

describe("invoiceChecklist", () => {
  it("invoiceChecklist_cartonsSameDayAndBill_groupedWithCountsDoneAndSorted", async () => {
    mp.carton.findMany.mockResolvedValue([
      { code: "GE 2", packedDate: new Date("2026-03-04T00:00:00Z"), trackings: [{ id: "1" }] },
      { code: "GE 1", packedDate: new Date("2026-03-04T00:00:00Z"), trackings: [{ id: "2" }, { id: "3" }] },
      { code: "GA 1", packedDate: new Date("2026-03-04T00:00:00Z"), trackings: [] },
      { code: "GB 1", packedDate: new Date("2026-03-01T00:00:00Z"), trackings: [] },
      { code: "GX 1", packedDate: null, trackings: [] },
    ]);
    mp.billInvoiceStatus.findMany.mockResolvedValue([{ key: "2026-03-04|GE", done: true }, { key: "2026-03-01|GB", done: false }]);
    const r = await invoiceChecklist({ start: new Date(0), end: new Date(1) });
    expect(r).toEqual([
      { key: "2026-03-01|GB", date: "2026-03-01", bill: "GB", cartonCount: 1, trackingCount: 0, done: false },
      { key: "2026-03-04|GA", date: "2026-03-04", bill: "GA", cartonCount: 1, trackingCount: 0, done: false },
      { key: "2026-03-04|GE", date: "2026-03-04", bill: "GE", cartonCount: 2, trackingCount: 3, done: true },
    ]);
  });

  it("invoiceChecklist_noCartons_skipsStatusQuery", async () => {
    mp.carton.findMany.mockResolvedValue([]);
    expect(await invoiceChecklist({ start: new Date(0), end: new Date(1) })).toEqual([]);
    expect(mp.billInvoiceStatus.findMany).not.toHaveBeenCalled();
  });

  it("setInvoiceDone_givenKey_upsertsDoneWithUpdatedBy", async () => {
    await setInvoiceDone("2026-03-04|GE", true, actor);
    expect(mp.billInvoiceStatus.upsert).toHaveBeenCalledWith({
      where: { key: "2026-03-04|GE" }, update: { done: true, updatedBy: "u1" }, create: { key: "2026-03-04|GE", done: true, updatedBy: "u1" },
    });
  });
});

describe("uploadDocument / openDocument", () => {
  const file = { path: "/tmp/x", size: 10, safeName: "hd.pdf", mime: "application/pdf" };

  it("uploadDocument_valid_storesUnderTypePrefixAndAudits", async () => {
    mp.document.create.mockResolvedValue({ id: "d1" });
    await uploadDocument(file, { type: "invoice", orderId: "" }, actor);
    const key = (putObjectFromFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(key).toMatch(/^documents\/invoice\/[0-9a-f-]{36}-hd\.pdf$/);
    expect(mp.document.create.mock.calls[0][0].data).toMatchObject({ type: "invoice", objectKey: key, orderId: null, invoiceDate: null, uploadedBy: "u1" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "d1", action: "document.uploaded", metadata: { type: "invoice" } }));
  });

  it("openDocument_storageFails_throws500DownloadFailed", async () => {
    mp.document.findUnique.mockResolvedValue({ id: "d1", objectKey: "documents/invoice/u-hd.pdf" });
    (getObjectStream as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("minio down"));
    await expect(openDocument("d1")).rejects.toMatchObject({ status: 500, code: "DOWNLOAD_FAILED" });
  });

  it("openDocument_found_returnsLastKeySegmentAsFilename", async () => {
    mp.document.findUnique.mockResolvedValue({ id: "d1", objectKey: "documents/invoice/u-hd.pdf" });
    (getObjectStream as ReturnType<typeof vi.fn>).mockResolvedValue("STREAM");
    expect(await openDocument("d1")).toEqual({ filename: "u-hd.pdf", stream: "STREAM" });
  });
});
