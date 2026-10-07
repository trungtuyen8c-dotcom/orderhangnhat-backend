import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    wallet: { findUnique: vi.fn() },
    statementImport: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    statementImportRow: { createMany: vi.fn(), update: vi.fn() },
    walletStatementMapping: { findUnique: vi.fn(), upsert: vi.fn() },
    walletTxn: { findMany: vi.fn(), updateMany: vi.fn() },
    $queryRaw: vi.fn(),
  };
  p.$transaction = vi.fn(async (arg: any) => (Array.isArray(arg) ? Promise.all(arg) : arg(p)));
  return { prisma: p };
});
vi.mock("./accounting.repository.js", () => ({ writeAudit: vi.fn() }));

import { Prisma } from "@prisma/client";
import { commitImport, createImport, deleteImport, getImport, previewMatches, statementRefOf } from "./statementImport.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { writeAudit } from "./accounting.repository.js";
import { AppError } from "../../app/errors/AppError.js";

const mp = prisma as any;
const actor = { id: "u1", requestId: "r1" };
const CSV = 'Date,Amount,Ref\n2026-10-07,"-100,000",REF1\n2026-10-08,50000,\nbad,1,\n';
const CSV_SHA256 = "a887f3261707f7806274c8961fb918787757ca0b6a37b5f35916555a7c3e29dd";
const file = (text = CSV, ext = "csv") => ({ buffer: Buffer.from(text), ext, fileName: "mb.csv" });
const mapping = { headerRow: 1, dateCol: 0, amountMode: "signed", amountCol: 1, referenceCol: 2 };
const rawRows = [
  { rowIndex: 0, cells: ["Date", "Amount", "Ref"] },
  { rowIndex: 1, cells: ["2026-10-07", "-100,000", "REF1"] },
  { rowIndex: 2, cells: ["2026-10-08", "50000", ""] },
  { rowIndex: 3, cells: ["bad", "1", ""] },
];
const draft = (over: Record<string, unknown> = {}) => ({ id: "imp1", walletId: "w1", fileName: "mb.csv", status: "draft", mapping, toleranceDays: 2, rows: rawRows, ...over });
// 2026-10-06 18:00 UTC = 07/10 01:00 giờ VN.
const txn = (over: Record<string, unknown> = {}) => ({ id: "t1", walletId: "w1", amount: "-100000", reconciled: false, createdAt: new Date("2026-10-06T18:00:00Z"), ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mp.wallet.findUnique.mockResolvedValue({ id: "w1", name: "MB", currency: "VND" });
  mp.statementImport.findUnique.mockResolvedValue(null);
  mp.walletStatementMapping.findUnique.mockResolvedValue(null);
  mp.walletTxn.findMany.mockResolvedValue([]);
  mp.walletTxn.updateMany.mockResolvedValue({ count: 1 });
});

async function rejection(p: Promise<unknown>) {
  try { await p; } catch (e) { return e as AppError; }
  throw new Error("expected rejection");
}

describe("statementRefOf", () => {
  it.each([
    ["with reference", { rowIndex: 1, reference: "REF1" }, "mb.csv#2 REF1"],
    ["without reference", { rowIndex: 0, reference: null }, "mb.csv#1"],
  ])("statementRefOf_%s_isFileHashOneBasedRow", (_n, row, expected) => {
    expect(statementRefOf("mb.csv", row)).toBe(expected);
  });

  it("statementRefOf_veryLongReference_truncatedTo500Chars", () => {
    expect(statementRefOf("mb.csv", { rowIndex: 0, reference: "x".repeat(600) })).toHaveLength(500);
  });
});

describe("createImport", () => {
  it("createImport_walletMissing_throws404AndCreatesNothing", async () => {
    mp.wallet.findUnique.mockResolvedValue(null);
    const e = await rejection(createImport("w9", file(), actor));
    expect([e.status, e.code]).toEqual([404, "WALLET_NOT_FOUND"]);
    expect(mp.statementImport.create).not.toHaveBeenCalled();
  });

  it("createImport_sameFileAlreadyCommitted_throws409DuplicateWithImportId", async () => {
    mp.statementImport.findUnique.mockResolvedValue({ id: "old", status: "committed", fileName: "t9.csv" });
    const e = await rejection(createImport("w1", file(), actor));
    expect(e.status).toBe(409);
    expect(e.toBody()).toEqual({ error: "CONFLICT_DUPLICATE_FILE", message: "File này đã import cho ví này (t9.csv)", detail: { importId: "old" } });
  });

  it("createImport_sameFileStillDraft_resumesExistingDraftWithoutCreating", async () => {
    mp.statementImport.findUnique.mockResolvedValue({ ...draft({ id: "old", rowCount: 4, rows: [] }) });
    const r = await createImport("w1", file(), actor);
    expect([r.id, r.resumed]).toEqual(["old", true]);
    expect(mp.statementImport.create).not.toHaveBeenCalled();
  });

  it("createImport_unreadableXlsx_throws400BadFile", async () => {
    const e = await rejection(createImport("w1", file("not a zip", "xlsx"), actor));
    expect(e.toBody()).toEqual({ error: "BAD_FILE", message: "Không đọc được file sao kê" });
  });

  it("createImport_onlyBlankLines_throws400NoData", async () => {
    const e = await rejection(createImport("w1", file("\n\n,,\n"), actor));
    expect(e.toBody()).toEqual({ error: "BAD_FILE", message: "File không có dữ liệu" });
  });

  it("createImport_moreThanMaxRowsPlus100_throws400TooManyRows", async () => {
    const e = await rejection(createImport("w1", file("a\n".repeat(5101)), actor));
    expect(e.toBody()).toEqual({ error: "BAD_FILE", message: "File quá nhiều dòng (tối đa 5000)" });
  });

  it("createImport_exactlyMaxRowsPlus100_accepted", async () => {
    mp.statementImport.findUnique.mockResolvedValueOnce(null).mockResolvedValue(draft({ rows: [] }));
    await createImport("w1", file("a\n".repeat(5100)), actor);
    expect(mp.statementImport.create.mock.calls[0][0].data.rowCount).toBe(5100);
  });

  it("createImport_newFile_storesHashRowsAndAuditThenReturnsNotResumed", async () => {
    mp.statementImport.findUnique.mockResolvedValueOnce(null).mockResolvedValue(draft({ rows: [] }));
    const r = await createImport("w1", file(), actor);
    expect(r.resumed).toBe(false);
    expect(mp.statementImport.create.mock.calls[0][0].data).toMatchObject({ walletId: "w1", fileName: "mb.csv", fileHash: CSV_SHA256, rowCount: 4, createdBy: "u1" });
    expect(mp.statementImportRow.createMany.mock.calls[0][0].data.map((r: any) => [r.rowIndex, r.cells])).toEqual([
      [0, ["Date", "Amount", "Ref"]],
      [1, ["2026-10-07", "-100,000", "REF1"]],
      [2, ["2026-10-08", "50000", ""]],
      [3, ["bad", "1", ""]],
    ]);
    expect((writeAudit as any).mock.calls[0][1]).toMatchObject({ action: "statement_import.created", metadata: { walletId: "w1", fileName: "mb.csv", rows: 4 } });
  });

  it("createImport_concurrentUploadUniqueViolation_throws409Duplicate", async () => {
    mp.statementImport.create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5.22.0" }));
    const e = await rejection(createImport("w1", file(), actor));
    expect(e.toBody()).toEqual({ error: "CONFLICT_DUPLICATE_FILE", message: "File này đang được import cho ví này" });
  });

  it("createImport_otherDbError_rethrownAsIs", async () => {
    mp.statementImport.create.mockRejectedValueOnce(new Error("db down"));
    await expect(createImport("w1", file(), actor)).rejects.toThrow("db down");
  });
});

describe("getImport", () => {
  it("getImport_missing_throws404", async () => {
    const e = await rejection(getImport("x"));
    expect(e.toBody()).toEqual({ error: "NOT_FOUND", message: "Không tìm thấy lần import" });
  });

  it("getImport_committedRows_dateAsYmdAndDecimalAmountAsNumber", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ rows: [
      { rowIndex: 1, cells: ["x"], txnDate: new Date("2026-10-07T00:00:00Z"), amount: "-100000.5", description: null, reference: "R", matchedTxnId: "t1" },
      { rowIndex: 2, cells: ["y"], txnDate: null, amount: null, description: null, reference: null, matchedTxnId: null },
    ] }));
    const r = await getImport("imp1");
    expect(r.rows.map((x) => [x.date, x.amount, x.matchedTxnId])).toEqual([["2026-10-07", -100000.5, "t1"], [null, null, null]]);
  });

  it("getImport_walletSavedMappingInvalid_savedMappingNull", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ rows: [] }));
    mp.walletStatementMapping.findUnique.mockResolvedValue({ mapping: { headerRow: "x" } });
    expect((await getImport("imp1")).savedMapping).toBeNull();
  });

  it("getImport_walletSavedMappingValid_returnedWithDefaults", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ rows: [] }));
    mp.walletStatementMapping.findUnique.mockResolvedValue({ mapping });
    expect((await getImport("imp1")).savedMapping).toMatchObject({ ...mapping, dateFormat: "DMY" });
  });
});

describe("previewMatches", () => {
  it("previewMatches_importMissing_throws404", async () => {
    expect((await rejection(previewMatches("x", { mapping: mapping as any }, actor))).status).toBe(404);
  });

  it("previewMatches_importCommitted_throws409AndSavesNothing", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ status: "committed" }));
    const e = await rejection(previewMatches("imp1", { mapping: mapping as any }, actor));
    expect([e.status, e.code]).toEqual([409, "STATE_CONFLICT"]);
    expect(mp.walletStatementMapping.upsert).not.toHaveBeenCalled();
  });

  it("previewMatches_noTolerance_savesMappingForWalletAndImportWithDefault2Days", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    const r = await previewMatches("imp1", { mapping: mapping as any }, actor);
    expect(r.toleranceDays).toBe(2);
    expect(mp.walletStatementMapping.upsert).toHaveBeenCalledWith({
      where: { walletId: "w1" }, update: { mapping, updatedBy: "u1" }, create: { walletId: "w1", mapping, updatedBy: "u1" },
    });
    expect(mp.statementImport.update).toHaveBeenCalledWith({ where: { id: "imp1" }, data: { mapping, toleranceDays: 2 } });
  });

  it("previewMatches_rowDates_queriesOnlyUnreconciledTxnsInVnWindowWithTolerance", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    await previewMatches("imp1", { mapping: mapping as any, toleranceDays: 3 }, actor);
    expect(mp.walletTxn.findMany.mock.calls[0][0].where).toEqual({
      walletId: "w1", reconciled: false,
      createdAt: { gte: new Date("2026-10-03T17:00:00.000Z"), lte: new Date("2026-10-11T16:59:59.999Z") },
    });
  });

  it("previewMatches_txnInEarlyVnMorning_proposedWithVnDateAndZeroDayDiff", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([{ ...txn(), type: "order_payment", category: null, note: "OD1" }]);
    const r = await previewMatches("imp1", { mapping: mapping as any }, actor);
    expect(r.rows.find((x) => x.rowIndex === 1)!.proposal).toEqual({ txnId: "t1", dayDiff: 0, amount: -100000, date: "2026-10-07", type: "order_payment", category: null, note: "OD1" });
    expect(r.candidateTxnCount).toBe(1);
  });

  it("previewMatches_rowsWithoutMatch_proposalNullAndErrorRowKept", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    const r = await previewMatches("imp1", { mapping: mapping as any }, actor);
    expect(r.rows.map((x) => [x.rowIndex, x.error, x.proposal])).toEqual([[1, null, null], [2, null, null], [3, "DATE", null]]);
  });

  it("previewMatches_noParseableDates_skipsTxnQueryAndZeroCandidates", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ rows: [rawRows[0], rawRows[3]] }));
    const r = await previewMatches("imp1", { mapping: mapping as any }, actor);
    expect(r.candidateTxnCount).toBe(0);
    expect(mp.walletTxn.findMany).not.toHaveBeenCalled();
  });
});

describe("commitImport", () => {
  const ok = { matches: [{ rowIndex: 1, txnId: "t1" }] };

  it("commitImport_importMissing_throws404", async () => {
    expect((await rejection(commitImport("x", ok, actor))).status).toBe(404);
  });

  it("commitImport_alreadyCommitted_throws409StateConflict", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ status: "committed" }));
    const e = await rejection(commitImport("imp1", ok, actor));
    expect(e.toBody()).toEqual({ error: "STATE_CONFLICT", message: "Lần import này đã chốt" });
  });

  it("commitImport_noMappingYet_throws400", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ mapping: null }));
    const e = await rejection(commitImport("imp1", ok, actor));
    expect([e.status, e.message]).toEqual([400, "Chưa chọn cột cho file sao kê"]);
  });

  it.each([
    ["same row twice", [{ rowIndex: 1, txnId: "t1" }, { rowIndex: 1, txnId: "t2" }]],
    ["same txn twice", [{ rowIndex: 1, txnId: "t1" }, { rowIndex: 2, txnId: "t1" }]],
  ])("commitImport_%s_throws400OneToOne", async (_n, matches) => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    const e = await rejection(commitImport("imp1", { matches }, actor));
    expect([e.status, e.message]).toEqual([400, "Mỗi dòng sao kê / giao dịch chỉ được ghép 1 lần"]);
  });

  it.each([
    ["txn of another wallet", { rowIndex: 1, txnId: "t1" }, [txn({ walletId: "w2" })], "Cặp ghép không hợp lệ (dòng 2)"],
    ["txn not found", { rowIndex: 1, txnId: "t1" }, [], "Cặp ghép không hợp lệ (dòng 2)"],
    ["header row", { rowIndex: 0, txnId: "t1" }, [txn()], "Cặp ghép không hợp lệ (dòng 1)"],
    ["row with parse error", { rowIndex: 3, txnId: "t1" }, [txn()], "Cặp ghép không hợp lệ (dòng 4)"],
    ["amount differs", { rowIndex: 1, txnId: "t1" }, [txn({ amount: "-99999" })], "Dòng 2 lệch số tiền hoặc quá 2 ngày"],
    ["date beyond tolerance", { rowIndex: 1, txnId: "t1" }, [txn({ createdAt: new Date("2026-10-04T05:00:00Z") })], "Dòng 2 lệch số tiền hoặc quá 2 ngày"],
  ])("commitImport_%s_throws400AndReconcilesNothing", async (_n, match, txns, message) => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue(txns);
    const e = await rejection(commitImport("imp1", { matches: [match] }, actor));
    expect([e.status, e.message]).toEqual([400, message]);
    expect(mp.walletTxn.updateMany).not.toHaveBeenCalled();
  });

  it("commitImport_txnAlreadyReconciled_throws409", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn({ reconciled: true })]);
    const e = await rejection(commitImport("imp1", ok, actor));
    expect(e.toBody()).toEqual({ error: "CONFLICT_ALREADY_RECONCILED", message: "Giao dịch ở dòng 2 đã được đối soát" });
  });

  it("commitImport_importToleranceWider_acceptsDateWithinIt", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ toleranceDays: 5 }));
    mp.walletTxn.findMany.mockResolvedValue([txn({ createdAt: new Date("2026-10-03T05:00:00Z") })]);
    expect((await commitImport("imp1", ok, actor)).matched).toBe(1);
  });

  it("commitImport_reconciledConcurrentlyBetweenReadAndUpdate_throws409AndDoesNotMarkCommitted", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn()]);
    mp.walletTxn.updateMany.mockResolvedValue({ count: 0 });
    const e = await rejection(commitImport("imp1", ok, actor));
    expect([e.status, e.code]).toEqual([409, "CONFLICT_ALREADY_RECONCILED"]);
    expect(mp.statementImport.update).not.toHaveBeenCalled();
  });

  it("commitImport_validMatch_marksTxnReconciledWithStatementRefGuardedByUnreconciled", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn()]);
    await commitImport("imp1", ok, actor);
    expect(mp.walletTxn.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", walletId: "w1", reconciled: false }, data: { reconciled: true, statementRef: "mb.csv#2 REF1" },
    });
  });

  it("commitImport_validMatch_auditsEachReconciledTxnAndTheImport", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn()]);
    await commitImport("imp1", ok, actor);
    const audits = (writeAudit as any).mock.calls.map((c: any[]) => c[1]);
    expect(audits).toEqual([
      { actorId: "u1", targetId: "t1", action: "wallet_txn.reconciled", requestId: "r1", metadata: { statementRef: "mb.csv#2 REF1", importId: "imp1" } },
      { actorId: "u1", targetId: "imp1", action: "statement_import.committed", requestId: "r1", metadata: { walletId: "w1", fileName: "mb.csv", matched: 1, unmatched: 2, txnIds: ["t1"] } },
    ]);
  });

  it("commitImport_validMatch_persistsParsedRowsWithMatchedTxnId", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn()]);
    await commitImport("imp1", ok, actor);
    const updates = mp.statementImportRow.update.mock.calls.map((c: any[]) => [c[0].where.importId_rowIndex.rowIndex, c[0].data]);
    expect(updates).toEqual([
      [1, { txnDate: new Date("2026-10-07T00:00:00Z"), amount: -100000, description: null, reference: "REF1", matchedTxnId: "t1" }],
      [2, { txnDate: new Date("2026-10-08T00:00:00Z"), amount: 50000, description: null, reference: null, matchedTxnId: null }],
      [3, { txnDate: null, amount: 1, description: null, reference: null, matchedTxnId: null }],
    ]);
  });

  it("commitImport_validMatch_marksImportCommittedAndReturnsUnmatchedRows", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    mp.walletTxn.findMany.mockResolvedValue([txn()]);
    const r = await commitImport("imp1", ok, actor);
    expect(mp.statementImport.update.mock.calls[0][0]).toMatchObject({ where: { id: "imp1" }, data: { status: "committed", committedBy: "u1" } });
    expect([r.matched, r.unmatched.map((x) => x.rowIndex)]).toEqual([1, [2, 3]]);
  });

  it("commitImport_noMatches_commitsWithAllRowsUnmatchedAndNoTxnTouched", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    const r = await commitImport("imp1", { matches: [] }, actor);
    expect([r.matched, r.unmatched.length]).toEqual([0, 3]);
    expect(mp.walletTxn.findMany).not.toHaveBeenCalled();
    expect(mp.walletTxn.updateMany).not.toHaveBeenCalled();
  });

  it("commitImport_any_locksImportRowBeforeReading", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    await commitImport("imp1", { matches: [] }, actor);
    expect(mp.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mp.statementImport.findUnique.mock.invocationCallOrder[0]);
  });
});

describe("deleteImport", () => {
  it("deleteImport_missing_throws404", async () => {
    expect((await rejection(deleteImport("x", actor))).status).toBe(404);
  });

  it("deleteImport_committed_throws409AndKeepsHistory", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft({ status: "committed" }));
    const e = await rejection(deleteImport("imp1", actor));
    expect(e.toBody()).toEqual({ error: "STATE_CONFLICT", message: "Lần import đã chốt, không xóa được" });
    expect(mp.statementImport.delete).not.toHaveBeenCalled();
  });

  it("deleteImport_draft_deletesAndAudits", async () => {
    mp.statementImport.findUnique.mockResolvedValue(draft());
    expect(await deleteImport("imp1", actor)).toEqual({ ok: true });
    expect(mp.statementImport.delete).toHaveBeenCalledWith({ where: { id: "imp1" } });
    expect((writeAudit as any).mock.calls[0][1]).toEqual({ actorId: "u1", targetId: "imp1", action: "statement_import.deleted", requestId: "r1", metadata: { walletId: "w1", fileName: "mb.csv" } });
  });
});
