import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const db: any = {
    wallet: { findUnique: vi.fn() },
    walletTxn: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    order: { findMany: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db));
  return { db };
});

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: h.db }));
vi.mock("../../app/audit.js", async (orig) => ({ ...(await orig<typeof import("../../app/audit.js")>()), logAudit: vi.fn() }));
vi.mock("./accounting.repository.js", async (orig) => ({ ...(await orig<typeof import("./accounting.repository.js")>()), writeAudit: vi.fn() }));
vi.mock("./wallet.service.js", () => ({ postWalletTxn: vi.fn(), deleteWalletTxnsById: vi.fn() }));
vi.mock("./fund.service.js", () => ({ recordFundTxn: vi.fn() }));

import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { writeAudit } from "./accounting.repository.js";
import { recordFundTxn } from "./fund.service.js";
import { deleteWalletTxnsById, postWalletTxn } from "./wallet.service.js";
import { backfillYahooDates, deleteCardTxn, reconcileTxn, recordCardTxn, recordCashback, transfer } from "./card.service.js";

const db = h.db;
const actor = { id: "u1", requestId: "r1" };
const NOW = new Date("2026-10-07T03:00:00.000Z");
let publish: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  publish = vi.spyOn(eventBus, "publish").mockImplementation(() => {});
  vi.mocked(postWalletTxn).mockResolvedValue({ txn: { id: "t1" }, wallet: { id: "w1", balance: "4000" } } as any);
});
afterEach(() => {
  publish.mockRestore();
  vi.useRealTimers();
});

describe("recordCardTxn", () => {
  it.each([
    { category: "Mua hàng", signed: -1000 },
    { category: "Hoàn tiền", signed: 1000 },
    { category: "Nạp tiền", signed: 1000 },
    { category: "Thu khác", signed: 1000 },
    { category: "Phí dịch vụ", signed: -1000 },
    { category: "Phí nạp tiền", signed: -1000 },
    { category: "Lỗi giao dịch", signed: -1000 },
    { category: "Chi khác", signed: -1000 },
  ])("recordCardTxn_category $category_postsSignedAmount $signed", async ({ category, signed }) => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordCardTxn({ walletId: "w1", category, amount: 1000 }, actor);
    expect(vi.mocked(postWalletTxn).mock.calls[0][1].amount).toBe(signed);
  });

  it("recordCardTxn_walletMissing_throws404AndPostsNothing", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await recordCardTxn({ walletId: "w1", category: "Mua hàng", amount: 1000 }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(postWalletTxn).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("recordCardTxn_noOptionalFields_postsNullRefsAndNowDate", async () => {
    vi.useFakeTimers({ now: NOW });
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordCardTxn({ walletId: "w1", category: "Mua hàng", amount: 1000 }, actor);
    expect(postWalletTxn).toHaveBeenCalledWith(db, {
      walletId: "w1", amount: -1000, type: "Mua hàng", category: "Mua hàng", note: null, refOrderId: null, createdAt: NOW,
    });
  });

  it("recordCardTxn_withDateNoteAndOrder_postsThem", async () => {
    const date = new Date("2026-09-01T00:00:00.000Z");
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordCardTxn({ walletId: "w1", category: "Mua hàng", amount: 1000, note: "n", date, refOrderId: "o1" }, actor);
    expect(vi.mocked(postWalletTxn).mock.calls[0][1]).toMatchObject({ note: "n", refOrderId: "o1", createdAt: date });
  });

  it("recordCardTxn_success_returnsTxnAndNumericBalance", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    const r = await recordCardTxn({ walletId: "w1", category: "Mua hàng", amount: 1000 }, actor);
    expect(r).toEqual({ txn: { id: "t1" }, balance: 4000 });
  });

  it("recordCardTxn_success_auditsAndPublishesEvent", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordCardTxn({ walletId: "w1", category: "Mua hàng", amount: 1000 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "w1", action: "wallet.txn", metadata: { category: "Mua hàng", amount: -1000 } }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "wallet.transaction_created", entityId: "t1", metadata: { walletId: "w1", category: "Mua hàng", amount: -1000 },
    }));
  });
});

describe("transfer", () => {
  const wallets = (from: any, to: any) => {
    db.wallet.findUnique.mockImplementation(async ({ where }: any) => (where.id === "wa" ? from : where.id === "wb" ? to : null));
  };
  const A = { id: "wa", name: "VCB", currency: "VND" };
  const B = { id: "wb", name: "TCB", currency: "VND" };

  it.each([
    { name: "source missing", from: null, to: B },
    { name: "target missing", from: A, to: null },
  ])("transfer_$name_throws404WalletNotFound", async ({ from, to }) => {
    wallets(from, to);
    const err = await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100 }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(postWalletTxn).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("transfer_noFeeNoNote_postsTwoLegsWithDefaultNotesAndSharedRef", async () => {
    vi.useFakeTimers({ now: NOW });
    wallets(A, B);
    await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100 }, actor);
    const legs = vi.mocked(postWalletTxn).mock.calls.map((c) => c[1]);
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ walletId: "wa", amount: -100, type: "Chuyển khoản", note: "Chuyển sang TCB", createdAt: NOW });
    expect(legs[1]).toMatchObject({ walletId: "wb", amount: 100, type: "Nhập tiền", note: "Nhận từ VCB", createdAt: NOW });
    expect(legs[0].transferRef).toBe(legs[1].transferRef);
  });

  it("transfer_withFee_postsFeeLegFromSourceInSameGroup", async () => {
    wallets(A, B);
    await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100, fee: 5 }, actor);
    const legs = vi.mocked(postWalletTxn).mock.calls.map((c) => c[1]);
    expect(legs).toHaveLength(3);
    expect(legs[2]).toMatchObject({ walletId: "wa", amount: -5, type: "Phí dịch vụ", note: "Phí chuyển sang TCB", transferRef: legs[0].transferRef });
  });

  it("transfer_zeroFee_postsNoFeeLeg", async () => {
    wallets(A, B);
    await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100, fee: 0 }, actor);
    expect(postWalletTxn).toHaveBeenCalledTimes(2);
  });

  it("transfer_customNote_usedOnBothLegs", async () => {
    wallets(A, B);
    await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100, note: "rút" }, actor);
    const legs = vi.mocked(postWalletTxn).mock.calls.map((c) => c[1]);
    expect([legs[0].note, legs[1].note]).toEqual(["rút", "rút"]);
  });

  it("transfer_success_auditsAndPublishesCompletedEvent", async () => {
    wallets(A, B);
    await transfer({ fromWalletId: "wa", toWalletId: "wb", amount: 100, fee: 5 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "wallet.transfer", metadata: { from: "VCB", to: "TCB", amount: 100, fee: 5 } }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "wallet.transfer_completed", entityId: vi.mocked(postWalletTxn).mock.calls[0][1].transferRef,
      metadata: { fromWalletId: "wa", toWalletId: "wb", amount: 100, fee: 5 },
    }));
  });
});

describe("deleteCardTxn", () => {
  it("deleteCardTxn_missing_throws404", async () => {
    db.walletTxn.findUnique.mockResolvedValue(null);
    const err = await deleteCardTxn("t1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(deleteWalletTxnsById).not.toHaveBeenCalled();
  });

  it("deleteCardTxn_plainTxn_deletesOnlyThatTxn", async () => {
    const txn = { id: "t1", walletId: "w1", amount: "-1000", transferRef: null, category: "Mua hàng" };
    db.walletTxn.findUnique.mockResolvedValue(txn);
    await deleteCardTxn("t1", actor);
    expect(deleteWalletTxnsById).toHaveBeenCalledWith(db, [txn]);
  });

  it("deleteCardTxn_transferLeg_deletesWholeTransferGroup", async () => {
    const group = [{ id: "t1", transferRef: "ref1" }, { id: "t2", transferRef: "ref1" }, { id: "t3", transferRef: "ref1" }];
    db.walletTxn.findUnique.mockResolvedValue({ id: "t1", walletId: "w1", transferRef: "ref1", category: "Chuyển khoản" });
    db.walletTxn.findMany.mockResolvedValue(group);
    await deleteCardTxn("t1", actor);
    expect(deleteWalletTxnsById).toHaveBeenCalledWith(db, group);
  });

  it("deleteCardTxn_success_auditsWithCategory", async () => {
    db.walletTxn.findUnique.mockResolvedValue({ id: "t1", walletId: "w1", transferRef: null, category: "Mua hàng" });
    await deleteCardTxn("t1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "w1", action: "wallet.txn_deleted", metadata: { category: "Mua hàng" } }));
  });
});

describe("reconcileTxn", () => {
  it("reconcileTxn_txn_marksReconciledWithRefAndAudits", async () => {
    db.walletTxn.update.mockResolvedValue({ id: "t1" });
    await reconcileTxn("t1", "SAO-01", actor);
    expect(db.walletTxn.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { reconciled: true, statementRef: "SAO-01" } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "t1", action: "wallet_txn.reconciled" }));
  });
});

describe("recordCashback", () => {
  it("recordCashback_noNote_recordsPendingCashbackFundTxnWithNullNote", async () => {
    await recordCashback({ walletId: "w1", amountYen: 800 }, actor);
    expect(recordFundTxn).toHaveBeenCalledWith(
      { type: "cashback", amountYen: 800, walletId: "w1", note: null },
      { action: "wallet.cashback_recorded", targetId: "w1", metadata: { amountYen: 800 } },
      actor,
    );
  });
});

describe("backfillYahooDates", () => {
  const order = (over: Record<string, unknown> = {}) => ({
    id: "o1", orderDate: new Date("2026-08-01T00:00:00.000Z"), items: [{ purchaseDate: new Date("2026-08-03T00:00:00.000Z") }], ...over,
  });

  it("backfillYahooDates_singleItemSingleTxnWrongDate_movesTxnToPurchaseDate", async () => {
    db.order.findMany.mockResolvedValue([order()]);
    db.walletTxn.findMany.mockResolvedValue([{ id: "t1", createdAt: new Date("2026-08-10T05:00:00.000Z") }]);
    const r = await backfillYahooDates(actor);
    expect(db.walletTxn.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { createdAt: new Date("2026-08-03T00:00:00.000Z") } });
    expect(r).toEqual({ updated: 1, skipped: 0, totalPaidOrders: 1 });
  });

  it("backfillYahooDates_itemWithoutPurchaseDate_fallsBackToOrderDate", async () => {
    db.order.findMany.mockResolvedValue([order({ items: [{ purchaseDate: null }] })]);
    db.walletTxn.findMany.mockResolvedValue([{ id: "t1", createdAt: new Date("2026-08-10T05:00:00.000Z") }]);
    await backfillYahooDates(actor);
    expect(db.walletTxn.update).toHaveBeenCalledWith({ where: { id: "t1" }, data: { createdAt: new Date("2026-08-01T00:00:00.000Z") } });
  });

  it("backfillYahooDates_sameUtcDay_leavesTxnUnchanged", async () => {
    db.order.findMany.mockResolvedValue([order()]);
    db.walletTxn.findMany.mockResolvedValue([{ id: "t1", createdAt: new Date("2026-08-03T15:00:00.000Z") }]);
    const r = await backfillYahooDates(actor);
    expect(db.walletTxn.update).not.toHaveBeenCalled();
    expect(r).toEqual({ updated: 0, skipped: 0, totalPaidOrders: 1 });
  });

  it.each([
    { name: "two txns", items: 1, txns: 2 },
    { name: "two items", items: 2, txns: 1 },
    { name: "no txn", items: 1, txns: 0 },
  ])("backfillYahooDates_$name_skipsOrder", async ({ items, txns }) => {
    const item = { purchaseDate: new Date("2026-08-03T00:00:00.000Z") };
    db.order.findMany.mockResolvedValue([order({ items: Array(items).fill(item) })]);
    db.walletTxn.findMany.mockResolvedValue(Array.from({ length: txns }, (_, i) => ({ id: `t${i}`, createdAt: new Date("2026-08-10T00:00:00.000Z") })));
    const r = await backfillYahooDates(actor);
    expect(db.walletTxn.update).not.toHaveBeenCalled();
    expect(r).toEqual({ updated: 0, skipped: 1, totalPaidOrders: 1 });
  });

  it("backfillYahooDates_run_auditsCounts", async () => {
    db.order.findMany.mockResolvedValue([]);
    await backfillYahooDates(actor);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "accounting.backfill_yahoo_dates", metadata: { updated: 0, skipped: 0 } }));
  });
});
