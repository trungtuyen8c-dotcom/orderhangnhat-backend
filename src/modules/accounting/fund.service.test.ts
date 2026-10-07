import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    order: { findUnique: vi.fn() },
    debt: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    fund: { update: vi.fn(), upsert: vi.fn() },
    wallet: { update: vi.fn(), findUnique: vi.fn() },
    walletTxn: { create: vi.fn(), deleteMany: vi.fn() },
    fundTxn: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    user: { findMany: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(p));
  return { prisma: p };
});
vi.mock("../../app/audit.js", async (orig) => ({ ...(await orig<typeof import("../../app/audit.js")>()), logAudit: vi.fn() }));
vi.mock("./accounting.repository.js", async (orig) => ({
  ...(await orig<typeof import("./accounting.repository.js")>()),
  lockFundTxn: vi.fn(),
  writeAudit: vi.fn(),
}));

import {
  applyFundTxn, confirmFundTxn, deleteFundTxn, fundCounts, listFund, recordFundTxn, requestFundFix, resolveFundFix,
  reverseFundTxn, unconfirmFundTxn,
} from "./fund.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { lockFundTxn, writeAudit } from "./accounting.repository.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  debt: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  fund: { update: ReturnType<typeof vi.fn> };
  wallet: { update: ReturnType<typeof vi.fn> };
  walletTxn: { create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};
// Hàm quỹ chạy trong transaction của caller -> test truyền mock làm tx.
const tx = prisma as any;

describe("applyFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applyFundTxn_topup_incrementsFundBalance", async () => {
    await applyFundTxn(tx, { id: "ft1", type: "topup", amountYen: 5000, walletId: null, note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 5000 } } });
  });

  it("applyFundTxn_set_setsFundBalanceAbsolute", async () => {
    await applyFundTxn(tx, { id: "ft1", type: "set", amountYen: 12000, walletId: null, note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 12000 } });
  });

  it("applyFundTxn_allocate_decrementsFundIncrementsWalletAndLogsTxn", async () => {
    await applyFundTxn(tx, { id: "ft1", type: "allocate", amountYen: 3000, walletId: "w1", note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { decrement: 3000 } } });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 3000 } } });
    expect(mockPrisma.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 3000, type: "fund_allocate", refFundTxnId: "ft1" },
    });
  });

  it("applyFundTxn_cashback_incrementsWalletAndLogsTxnWithStatementRef", async () => {
    await applyFundTxn(tx, { id: "ft1", type: "cashback", amountYen: 800, walletId: "w1", note: "sale 8%" });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 800 } } });
    expect(mockPrisma.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 800, type: "cashback", statementRef: "sale 8%", refFundTxnId: "ft1" },
    });
  });

  it("applyFundTxn_unknownType_makesNoWrites", async () => {
    await applyFundTxn(tx, { id: "ft1", type: "bogus", amountYen: 100, walletId: null, note: null });
    expect(mockPrisma.fund.update).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTxn.create).not.toHaveBeenCalled();
  });
});

describe("reverseFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reverseFundTxn_topup_decrementsFundBalance", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "topup", amountYen: 5000, walletId: null, prevBalance: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { decrement: 5000 } } });
  });

  it("reverseFundTxn_set_restoresPrevBalance", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "set", amountYen: 12000, walletId: null, prevBalance: "9000" });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 9000 } });
  });

  it("reverseFundTxn_allocate_incrementsFundDecrementsWalletAndDeletesLinkedTxn", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "allocate", amountYen: 3000, walletId: "w1", prevBalance: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 3000 } } });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 3000 } } });
    expect(mockPrisma.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refFundTxnId: "ft1" } });
  });

  it("reverseFundTxn_cashback_decrementsWalletAndDeletesLinkedTxn", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "cashback", amountYen: 800, walletId: "w1", prevBalance: null });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 800 } } });
    expect(mockPrisma.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refFundTxnId: "ft1" } });
  });

  it("reverseFundTxn_unknownType_makesNoWrites", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "bogus", amountYen: 100, walletId: null, prevBalance: null });
    expect(mockPrisma.fund.update).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTxn.deleteMany).not.toHaveBeenCalled();
  });
});

const db = prisma as any;
const actor = { id: "u1", requestId: "r1" };
const NOW = new Date("2026-10-07T03:00:00.000Z");
const fundTxn = (over: Record<string, unknown> = {}) => ({
  id: "ft1", type: "topup", amountYen: "5000", walletId: null, note: null, prevBalance: null, confirmed: false, ...over,
});

describe("reverseFundTxn (null prevBalance)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reverseFundTxn_setWithoutPrevBalance_resetsFundToZero", async () => {
    await reverseFundTxn(tx, { id: "ft1", type: "set", amountYen: 12000, walletId: null, prevBalance: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 0 } });
  });
});

describe("listFund", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.fund.upsert.mockResolvedValue({ id: "main", balance: "25000" });
    db.fundTxn.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
  });

  it.each([
    { status: "pending", where: { confirmed: false, fixRequest: null } },
    { status: "confirmed", where: { confirmed: true } },
    { status: "fix_request", where: { fixRequest: { not: null } } },
    { status: "all", where: {} },
  ])("listFund_status $status_filtersTxns", async ({ status, where }) => {
    await listFund(status);
    expect(db.fundTxn.findMany.mock.calls[0][0].where).toEqual(where);
  });

  it("listFund_fund_returnsNumericBalance", async () => {
    expect((await listFund("all")).balance).toBe(25000);
  });

  it("listFund_txns_enrichesUserNamesWithEmailFallback", async () => {
    db.fundTxn.findMany.mockResolvedValue([
      { id: "ft1", recordedBy: "u1", confirmedBy: "u2" },
      { id: "ft2", recordedBy: "u9", confirmedBy: null },
    ]);
    db.user.findMany.mockResolvedValue([{ id: "u1", fullName: "Mai", email: "m@x" }, { id: "u2", fullName: null, email: "k@x" }]);
    const { txns } = await listFund("all");
    expect(txns.map((t: any) => [t.recordedByName, t.confirmedByName])).toEqual([["Mai", "k@x"], [null, null]]);
  });
});

describe("fundCounts", () => {
  beforeEach(() => vi.clearAllMocks());

  it("fundCounts_counts_returnsNamedBuckets", async () => {
    db.fundTxn.count.mockResolvedValueOnce(2).mockResolvedValueOnce(7).mockResolvedValueOnce(1).mockResolvedValueOnce(10);
    expect(await fundCounts()).toEqual({ pending: 2, confirmed: 7, fixRequest: 1, all: 10 });
  });
});

describe("recordFundTxn", () => {
  let publish: ReturnType<typeof vi.spyOn>;
  const audit = { action: "fund.topup_recorded", metadata: { amountYen: 5000 } };
  beforeEach(() => {
    vi.clearAllMocks();
    publish = vi.spyOn(eventBus, "publish").mockImplementation(() => {});
    db.fundTxn.create.mockImplementation(async ({ data }: any) => ({ walletId: null, ...data }));
  });
  afterEach(() => publish.mockRestore());

  it("recordFundTxn_walletMissing_throws404AndCreatesNothing", async () => {
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await recordFundTxn({ type: "allocate", amountYen: 3000, walletId: "w1", note: null }, audit, actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
    expect(db.fundTxn.create).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("recordFundTxn_topup_createsPendingRowWithoutWalletOrPrevBalance", async () => {
    await recordFundTxn({ type: "topup", amountYen: 5000, note: "n" }, audit, actor);
    expect(db.fundTxn.create).toHaveBeenCalledWith({ data: { id: expect.any(String), type: "topup", amountYen: 5000, note: "n", recordedBy: "u1" } });
  });

  it("recordFundTxn_set_snapshotsCurrentFundBalanceAsPrevBalance", async () => {
    db.fund.upsert.mockResolvedValue({ id: "main", balance: "9000" });
    await recordFundTxn({ type: "set", amountYen: 12000, note: null }, audit, actor);
    expect(db.fundTxn.create.mock.calls[0][0].data.prevBalance).toBe("9000");
  });

  it("recordFundTxn_allocateWithRate_storesWalletAndRate", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordFundTxn({ type: "allocate", amountYen: 3000, rate: 172, walletId: "w1", note: null }, audit, actor);
    expect(db.fundTxn.create.mock.calls[0][0].data).toMatchObject({ walletId: "w1", rate: 172 });
  });

  it("recordFundTxn_success_doesNotChangeFundOrWallet", async () => {
    db.wallet.findUnique.mockResolvedValue({ id: "w1" });
    await recordFundTxn({ type: "allocate", amountYen: 3000, walletId: "w1", note: null }, audit, actor);
    expect(db.fund.update).not.toHaveBeenCalled();
    expect(db.wallet.update).not.toHaveBeenCalled();
  });

  it("recordFundTxn_success_writesCallerAuditAndPublishesCreatedEvent", async () => {
    await recordFundTxn({ type: "topup", amountYen: 5000, note: null }, { ...audit, targetId: "x1" }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "x1", action: "fund.topup_recorded", metadata: { amountYen: 5000 } }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "fund.created", metadata: { type: "topup", amountYen: 5000, walletId: null } }));
  });
});

describe("confirmFundTxn", () => {
  let publish: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.clearAllMocks();
    publish = vi.spyOn(eventBus, "publish").mockImplementation(() => {});
    db.fundTxn.update.mockImplementation(async ({ where, data }: any) => ({ ...fundTxn(), id: where.id, ...data }));
  });
  afterEach(() => {
    publish.mockRestore();
    vi.useRealTimers();
  });

  it("confirmFundTxn_missing_throws404", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(null);
    const err = await confirmFundTxn("ft1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("confirmFundTxn_alreadyConfirmed_returnsCurrentWithoutSideEffects", async () => {
    const cur = fundTxn({ confirmed: true });
    vi.mocked(lockFundTxn).mockResolvedValue(cur as any);
    const r = await confirmFundTxn("ft1", actor);
    expect(r).toBe(cur);
    expect(db.fund.update).not.toHaveBeenCalled();
    expect(db.fundTxn.update).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("confirmFundTxn_pendingTopup_incrementsFundAndMarksConfirmed", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn() as any);
    await confirmFundTxn("ft1", actor);
    expect(db.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 5000 } } });
    expect(db.fundTxn.update).toHaveBeenCalledWith({ where: { id: "ft1" }, data: { confirmed: true, confirmedBy: "u1", confirmedAt: NOW } });
  });

  it("confirmFundTxn_pending_auditsAndPublishesConfirmedEvent", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn() as any);
    await confirmFundTxn("ft1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "ft1", action: "fund.confirmed", metadata: { type: "topup", amountYen: 5000 } }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "fund.confirmed", entityId: "ft1", metadata: { type: "topup", amountYen: 5000, walletId: null } }));
  });
});

describe("unconfirmFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unconfirmFundTxn_missing_throws404", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(null);
    const err = await unconfirmFundTxn("ft1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("unconfirmFundTxn_pending_returnsCurrentWithoutWrites", async () => {
    const cur = fundTxn();
    vi.mocked(lockFundTxn).mockResolvedValue(cur as any);
    const r = await unconfirmFundTxn("ft1", actor);
    expect(r).toBe(cur);
    expect(db.fund.update).not.toHaveBeenCalled();
    expect(db.fundTxn.update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("unconfirmFundTxn_confirmedAllocate_reversesFundAndWalletAndResetsFlags", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn({ type: "allocate", amountYen: "3000", walletId: "w1", confirmed: true }) as any);
    await unconfirmFundTxn("ft1", actor);
    expect(db.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 3000 } } });
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 3000 } } });
    expect(db.fundTxn.update).toHaveBeenCalledWith({ where: { id: "ft1" }, data: { confirmed: false, confirmedBy: null, confirmedAt: null } });
  });

  it("unconfirmFundTxn_confirmed_audits", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn({ confirmed: true }) as any);
    await unconfirmFundTxn("ft1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "ft1", action: "fund.unconfirmed" }));
  });
});

describe("deleteFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteFundTxn_missing_throws404AndDeletesNothing", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(null);
    const err = await deleteFundTxn("ft1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.fundTxn.delete).not.toHaveBeenCalled();
  });

  it("deleteFundTxn_pending_deletesWithoutReversal", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn() as any);
    await deleteFundTxn("ft1", actor);
    expect(db.fund.update).not.toHaveBeenCalled();
    expect(db.fundTxn.delete).toHaveBeenCalledWith({ where: { id: "ft1" } });
  });

  it("deleteFundTxn_confirmedSet_restoresPrevBalanceAndDeletes", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn({ type: "set", amountYen: "12000", prevBalance: "9000", confirmed: true }) as any);
    await deleteFundTxn("ft1", actor);
    expect(db.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 9000 } });
    expect(db.fundTxn.delete).toHaveBeenCalledWith({ where: { id: "ft1" } });
  });

  it("deleteFundTxn_success_audits", async () => {
    vi.mocked(lockFundTxn).mockResolvedValue(fundTxn() as any);
    await deleteFundTxn("ft1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "ft1", action: "fund.deleted" }));
  });
});

describe("requestFundFix / resolveFundFix", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("requestFundFix_missing_throws404", async () => {
    db.fundTxn.findUnique.mockResolvedValue(null);
    const err = await requestFundFix("ft1", "sai", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.fundTxn.update).not.toHaveBeenCalled();
  });

  it("requestFundFix_existing_storesNoteAndAudits", async () => {
    vi.useFakeTimers({ now: NOW });
    db.fundTxn.findUnique.mockResolvedValue({ id: "ft1" });
    await requestFundFix("ft1", "sai", actor);
    expect(db.fundTxn.update).toHaveBeenCalledWith({ where: { id: "ft1" }, data: { fixRequest: "sai", fixRequestedAt: NOW } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "ft1", action: "fund.fix_requested", metadata: { note: "sai" } }));
  });

  it("resolveFundFix_missing_throws404", async () => {
    db.fundTxn.findUnique.mockResolvedValue(null);
    const err = await resolveFundFix("ft1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("resolveFundFix_existing_clearsRequestAndAudits", async () => {
    db.fundTxn.findUnique.mockResolvedValue({ id: "ft1" });
    await resolveFundFix("ft1", actor);
    expect(db.fundTxn.update).toHaveBeenCalledWith({ where: { id: "ft1" }, data: { fixRequest: null, fixRequestedAt: null } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "ft1", action: "fund.fix_resolved" }));
  });
});
