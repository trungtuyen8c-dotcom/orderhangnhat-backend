import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const db: any = {
    wallet: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    walletTxn: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn(), delete: vi.fn(), updateMany: vi.fn() },
    walletDailyActual: { upsert: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db));
  return { db };
});

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: h.db }));
vi.mock("../../app/audit.js", async (orig) => ({ ...(await orig<typeof import("../../app/audit.js")>()), logAudit: vi.fn() }));
vi.mock("./accounting.repository.js", async (orig) => ({
  ...(await orig<typeof import("./accounting.repository.js")>()),
  writeAudit: vi.fn(),
  countWalletRefs: vi.fn(),
}));

import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { writeAudit } from "./accounting.repository.js";
import {
  adjustDepositWalletTxn, createWallet, deleteWalletTxnsById, postWalletTxn, reverseFundWalletTxn,
  reversePaymentWallets, reverseWalletTxns, setDailyActual, setWalletOpening, updateWallet, walletLedger, walletNames,
} from "./wallet.service.js";

const db = h.db;
const tx = h.db;
const actor = { id: "u1", requestId: "r1" };

beforeEach(() => vi.clearAllMocks());

describe("postWalletTxn", () => {
  it.each([
    { name: "positive", amount: 500, data: { balance: { increment: 500 } } },
    { name: "negative", amount: -300, data: { balance: { decrement: 300 } } },
    { name: "zero", amount: 0, data: { balance: { increment: 0 } } },
  ])("postWalletTxn_$name amount_changesBalanceBySignedAmount", async ({ amount, data }) => {
    await postWalletTxn(tx, { walletId: "w1", amount, type: "x" });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data });
  });

  it("postWalletTxn_undefinedFields_omittedFromLedgerRow", async () => {
    await postWalletTxn(tx, { walletId: "w1", amount: 100, type: "x", note: null, statementRef: undefined });
    expect(db.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 100, type: "x", note: null },
    });
  });

  it("postWalletTxn_success_returnsTxnAndUpdatedWallet", async () => {
    db.wallet.update.mockResolvedValue({ id: "w1", balance: 900 });
    db.walletTxn.create.mockResolvedValue({ id: "t1" });
    const r = await postWalletTxn(tx, { walletId: "w1", amount: 100, type: "x" });
    expect(r).toEqual({ txn: { id: "t1" }, wallet: { id: "w1", balance: 900 } });
  });
});

describe("reverseWalletTxns", () => {
  it("reverseWalletTxns_matchingRows_reversesEachRowAndDeletesThem", async () => {
    db.walletTxn.findMany.mockResolvedValue([
      { id: "t1", walletId: "w1", amount: "200" },
      { id: "t2", walletId: "w2", amount: "-50" },
    ]);
    await reverseWalletTxns(tx, { refDepositId: "d1" });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 200 } } });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w2" }, data: { balance: { increment: 50 } } });
    expect(db.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refDepositId: "d1" } });
  });

  it("reverseWalletTxns_noRows_makesNoWrites", async () => {
    db.walletTxn.findMany.mockResolvedValue([]);
    const r = await reverseWalletTxns(tx, { refDepositId: "d1" });
    expect(r).toEqual([]);
    expect(db.wallet.update).not.toHaveBeenCalled();
    expect(db.walletTxn.deleteMany).not.toHaveBeenCalled();
  });
});

describe("deleteWalletTxnsById", () => {
  it("deleteWalletTxnsById_twoRows_reversesBalanceAndDeletesEachById", async () => {
    await deleteWalletTxnsById(tx, [
      { id: "t1", walletId: "w1", amount: -1000 },
      { id: "t2", walletId: "w2", amount: 1000 },
    ]);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 1000 } } });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w2" }, data: { balance: { decrement: 1000 } } });
    expect(db.walletTxn.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(db.walletTxn.delete).toHaveBeenCalledWith({ where: { id: "t2" } });
  });
});

describe("reverseFundWalletTxn", () => {
  it("reverseFundWalletTxn_amount_decrementsWalletAndDeletesLinkedTxn", async () => {
    await reverseFundWalletTxn(tx, "w1", 700, "ft1");
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 700 } } });
    expect(db.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refFundTxnId: "ft1" } });
  });
});

describe("adjustDepositWalletTxn", () => {
  it("adjustDepositWalletTxn_negativeDiff_decrementsWalletAndSetsLinkedTxnAmount", async () => {
    await adjustDepositWalletTxn(tx, "w1", "d1", -400, 600);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 400 } } });
    expect(db.walletTxn.updateMany).toHaveBeenCalledWith({ where: { refDepositId: "d1" }, data: { amount: 600 } });
  });
});

describe("reversePaymentWallets", () => {
  it("reversePaymentWallets_depositIntoWallet_decrementsWallet", async () => {
    await reversePaymentWallets(tx, [{ walletId: "w1", type: "deposit", amountOrig: "300" }]);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 300 } } });
  });

  it("reversePaymentWallets_refundFromWallet_incrementsWallet", async () => {
    await reversePaymentWallets(tx, [{ walletId: "w1", type: "refund", amountOrig: "300" }]);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 300 } } });
  });

  it("reversePaymentWallets_paymentWithoutWallet_skipped", async () => {
    await reversePaymentWallets(tx, [{ walletId: null, type: "deposit", amountOrig: "300" }]);
    expect(db.wallet.update).not.toHaveBeenCalled();
  });
});

describe("walletNames", () => {
  it("walletNames_wallets_returnsNamesOnly", async () => {
    db.wallet.findMany.mockResolvedValue([{ name: "TCB" }, { name: "VCB" }]);
    expect(await walletNames()).toEqual(["TCB", "VCB"]);
  });
});

describe("createWallet", () => {
  it("createWallet_nameTaken_throws409WalletExists", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w0", name: "VCB" });
    const err = await createWallet({ name: "VCB", currency: "VND" }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "WALLET_EXISTS", status: 409 });
    expect(db.wallet.create).not.toHaveBeenCalled();
  });

  it("createWallet_noBalance_createsWithZeroBalanceAndNoOpeningTxn", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.create.mockResolvedValue({ id: "w1" });
    await createWallet({ name: "VCB", currency: "VND" }, actor);
    expect(db.wallet.create).toHaveBeenCalledWith({ data: { id: expect.any(String), name: "VCB", currency: "VND", balance: 0 } });
    expect(db.walletTxn.create).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it("createWallet_withBalance_createsZeroThenPostsOpeningTxn", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.create.mockResolvedValue({ id: "w1" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "5000" });
    const r = await createWallet({ name: "VCB", currency: "VND", balance: 5000 }, actor);
    expect(db.wallet.create).toHaveBeenCalledWith({ data: expect.objectContaining({ balance: 0 }) });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 5000 } } });
    expect(db.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 5000, type: "opening", category: "Số dư đầu kỳ", statementRef: "opening" },
    });
    expect(r).toEqual({ id: "w1", balance: "5000" });
  });

  it("createWallet_withBalance_auditsInitialBalance", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.create.mockResolvedValue({ id: "w1" });
    await createWallet({ name: "VCB", currency: "VND", balance: 5000 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ targetId: "w1", action: "wallet.created", metadata: { balance: 5000 } }));
  });
});

describe("updateWallet", () => {
  it("updateWallet_missing_throws404WalletNotFound", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await updateWallet("w1", { balance: 250 }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(db.wallet.update).not.toHaveBeenCalled();
    expect(db.walletTxn.create).not.toHaveBeenCalled();
  });

  it("updateWallet_balanceChanged_postsAdjustTxnForDeltaWithoutWritingBalance", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "250" });
    await updateWallet("w1", { balance: 250 }, actor);
    expect(db.wallet.update).toHaveBeenCalledTimes(1);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 150 } } });
    expect(db.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 150, type: "adjust", category: "Điều chỉnh số dư" },
    });
  });

  it("updateWallet_balanceLowered_postsNegativeAdjust", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "40" });
    await updateWallet("w1", { balance: 40 }, actor);
    expect(db.walletTxn.create).toHaveBeenCalledWith({ data: expect.objectContaining({ amount: -60, type: "adjust" }) });
  });

  it("updateWallet_balanceUnchanged_postsNoTxn", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "100" });
    await updateWallet("w1", { balance: 100 }, actor);
    expect(db.walletTxn.create).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it("updateWallet_balanceChanged_auditsBeforeAndAfterBalance", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "250" });
    await updateWallet("w1", { balance: 250 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "wallet.updated", before: { balance: 100 }, after: { balance: 250 } }));
  });

  it("updateWallet_nameOnly_updatesNameAndAuditsWithoutBalanceSnapshot", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "100" });
    await updateWallet("w1", { name: "New" }, actor);
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { name: "New" } });
    expect(db.walletTxn.create).not.toHaveBeenCalled();
    const audit = vi.mocked(writeAudit).mock.calls[0][1];
    expect(audit.action).toBe("wallet.updated");
    expect(audit).not.toHaveProperty("before");
    expect(audit).not.toHaveProperty("after");
  });
});

describe("setWalletOpening", () => {
  const date = new Date("2026-10-01T00:00:00Z");

  it("setWalletOpening_missing_throws404WalletNotFound", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await setWalletOpening("w1", { amount: 100, date }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(db.walletTxn.findMany).not.toHaveBeenCalled();
  });

  it("setWalletOpening_existingOpening_reversesOldThenPostsNewAtDate", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "1000" });
    db.walletTxn.findMany.mockResolvedValue([{ id: "old", walletId: "w1", amount: "300" }]);
    db.wallet.findUniqueOrThrow.mockResolvedValue({ id: "w1", balance: "1200" });
    const r = await setWalletOpening("w1", { amount: 500, date }, actor);
    expect(db.walletTxn.findMany).toHaveBeenCalledWith({ where: { walletId: "w1", statementRef: "opening" } });
    expect(db.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { walletId: "w1", statementRef: "opening" } });
    expect(db.wallet.update.mock.calls.map((c: any[]) => c[0].data)).toEqual([
      { balance: { decrement: 300 } },
      { balance: { increment: 500 } },
    ]);
    expect(db.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 500, type: "opening", category: "Số dư đầu kỳ", statementRef: "opening", createdAt: date },
    });
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "wallet.opening_set", metadata: { amount: 500, date } }));
    expect(r).toEqual({ id: "w1", balance: "1200" });
  });

  it("setWalletOpening_zeroAmount_onlyRemovesOldOpening", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "300" });
    db.walletTxn.findMany.mockResolvedValue([{ id: "old", walletId: "w1", amount: "300" }]);
    await setWalletOpening("w1", { amount: 0, date }, actor);
    expect(db.walletTxn.deleteMany).toHaveBeenCalled();
    expect(db.walletTxn.create).not.toHaveBeenCalled();
  });
});

describe("walletLedger", () => {
  it("walletLedger_filters_queriesByWalletNameAndDateRange", async () => {
    db.walletTxn.findMany.mockResolvedValue([]);
    const from = new Date("2026-10-01T00:00:00Z");
    const to = new Date("2026-10-31T00:00:00Z");
    await walletLedger({ from, to, wallet: "VCB" });
    expect(db.walletTxn.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { wallet: { name: "VCB" }, createdAt: { gte: from, lte: to } },
      orderBy: { createdAt: "asc" },
    }));
  });

  it("walletLedger_noFilters_emptyWhere", async () => {
    db.walletTxn.findMany.mockResolvedValue([]);
    await walletLedger({});
    expect(db.walletTxn.findMany.mock.calls[0][0].where).toEqual({});
  });

  it("walletLedger_rows_mapsWalletNameCurrencyProjectAndNumericAmount", async () => {
    const d = new Date("2026-10-02T00:00:00Z");
    db.walletTxn.findMany.mockResolvedValue([
      { id: "t1", wallet: { name: "VCB", currency: "VND" }, project: "order", createdAt: d, amount: "-1500", type: "expense", category: "Ship", note: null },
    ]);
    expect(await walletLedger({})).toEqual([
      { id: "t1", wallet: "VCB", currency: "VND", project: "order", date: d, amount: -1500, type: "expense", category: "Ship", note: null },
    ]);
  });
});

describe("setDailyActual", () => {
  it("setDailyActual_walletMissing_throws404WalletNotFound", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await setDailyActual("w1", { date: "2026-10-07", actualBalance: 100 }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(db.walletDailyActual.upsert).not.toHaveBeenCalled();
  });

  it("setDailyActual_existingWallet_upsertsActualForThatDay", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    db.walletDailyActual.upsert.mockResolvedValue({ actualBalance: "123456" });
    await setDailyActual("w1", { date: "2026-10-07", actualBalance: 123456 }, actor);
    const arg = db.walletDailyActual.upsert.mock.calls[0][0];
    const date: Date = arg.where.walletId_date.date;
    expect([date.getFullYear(), date.getMonth(), date.getDate()]).toEqual([2026, 9, 7]);
    expect(arg.update).toEqual({ actualBalance: 123456, updatedBy: "u1" });
  });

  it("setDailyActual_success_returnsNumericBalanceAndAudits", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    db.walletDailyActual.upsert.mockResolvedValue({ actualBalance: "123456" });
    const r = await setDailyActual("w1", { date: "2026-10-07", actualBalance: 123456 }, actor);
    expect(r).toEqual({ date: "2026-10-07", actualBalance: 123456 });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "w1", action: "wallet.daily_actual_set" }));
  });
});
