import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const db: any = {
    wallet: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
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
  reversePaymentWallets, reverseWalletTxns, setDailyActual, updateWallet, walletNames,
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

  it("createWallet_noBalance_createsWithZeroBalance", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.create.mockResolvedValue({ id: "w1" });
    await createWallet({ name: "VCB", currency: "VND" }, actor);
    expect(db.wallet.create).toHaveBeenCalledWith({ data: { id: expect.any(String), name: "VCB", currency: "VND", balance: 0 } });
  });

  it("createWallet_withBalance_auditsInitialBalance", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.create.mockResolvedValue({ id: "w1" });
    await createWallet({ name: "VCB", currency: "VND", balance: 5000 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ targetId: "w1", action: "wallet.created", metadata: { balance: 5000 } }));
  });
});

describe("updateWallet", () => {
  it("updateWallet_balanceChanged_auditsBeforeAndAfterBalance", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.update.mockResolvedValue({ id: "w1", balance: "250" });
    await updateWallet("w1", { balance: 250 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ action: "wallet.updated", before: { balance: 100 }, after: { balance: 250 } }));
  });

  it("updateWallet_nameOnly_auditsWithoutBalanceSnapshot", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1", balance: "100" });
    db.wallet.update.mockResolvedValue({ id: "w1", balance: "100" });
    await updateWallet("w1", { name: "New" }, actor);
    const audit = vi.mocked(writeAudit).mock.calls[0][1];
    expect(audit.action).toBe("wallet.updated");
    expect(audit).not.toHaveProperty("before");
    expect(audit).not.toHaveProperty("after");
  });

  it("updateWallet_beforeRowMissing_auditsNullBeforeBalance", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    db.wallet.update.mockResolvedValue({ id: "w1", balance: "250" });
    await updateWallet("w1", { balance: 250 }, actor);
    expect(writeAudit).toHaveBeenCalledWith(tx, expect.objectContaining({ before: { balance: null } }));
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
