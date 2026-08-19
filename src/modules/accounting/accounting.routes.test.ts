import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../db.js", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    debt: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    fund: { update: vi.fn() },
    wallet: { update: vi.fn() },
    walletTxn: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { vnDayStart, vnDayEnd, recomputeDebt, applyFundTxn, reverseFundTxn } from "./accounting.routes.js";
import { prisma } from "../../db.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  debt: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  fund: { update: ReturnType<typeof vi.fn> };
  wallet: { update: ReturnType<typeof vi.fn> };
  walletTxn: { create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};

describe("vnDayStart / vnDayEnd", () => {
  it("vnDayStart_dateString_returnsMidnightVnTimeAsUtcInstant", () => {
    expect(vnDayStart("2026-03-05").toISOString()).toBe("2026-03-04T17:00:00.000Z");
  });

  it("vnDayEnd_dateString_returnsEndOfDayVnTimeAsUtcInstant", () => {
    expect(vnDayEnd("2026-03-05").toISOString()).toBe("2026-03-05T16:59:59.999Z");
  });
});

describe("recomputeDebt", () => {
  beforeEach(() => vi.clearAllMocks());

  it("recomputeDebt_orderNotFound_doesNotReadOrWriteDebt", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await recomputeDebt("missing-order");
    expect(mockPrisma.debt.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.debt.create).not.toHaveBeenCalled();
    expect(mockPrisma.debt.update).not.toHaveBeenCalled();
  });

  it("recomputeDebt_noExistingDebtRow_createsNewDebtWithComputedBalance", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "o1", customerId: "c1", totalVnd: "1000000", totalQuote: "0",
      payments: [{ type: "deposit", amountVnd: "300000", currency: "VND", amountOrig: "300000" }],
    });
    mockPrisma.debt.findFirst.mockResolvedValue(null);
    await recomputeDebt("o1");
    expect(mockPrisma.debt.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), orderId: "o1", customerId: "c1", balance: 700000, currency: "VND" },
    });
    expect(mockPrisma.debt.update).not.toHaveBeenCalled();
  });

  it("recomputeDebt_existingDebtRow_updatesBalanceNotCreate", async () => {
    mockPrisma.order.findUnique.mockResolvedValue({
      id: "o1", customerId: "c1", totalVnd: "1000000", totalQuote: "0",
      payments: [{ type: "deposit", amountVnd: "300000", currency: "VND", amountOrig: "300000" }],
    });
    mockPrisma.debt.findFirst.mockResolvedValue({ id: "d1" });
    await recomputeDebt("o1");
    expect(mockPrisma.debt.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { balance: 700000, currency: "VND" } });
    expect(mockPrisma.debt.create).not.toHaveBeenCalled();
  });
});

describe("applyFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applyFundTxn_topup_incrementsFundBalance", async () => {
    await applyFundTxn({ id: "ft1", type: "topup", amountYen: 5000, walletId: null, note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 5000 } } });
  });

  it("applyFundTxn_set_setsFundBalanceAbsolute", async () => {
    await applyFundTxn({ id: "ft1", type: "set", amountYen: 12000, walletId: null, note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 12000 } });
  });

  it("applyFundTxn_allocate_decrementsFundIncrementsWalletAndLogsTxn", async () => {
    await applyFundTxn({ id: "ft1", type: "allocate", amountYen: 3000, walletId: "w1", note: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { decrement: 3000 } } });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 3000 } } });
    expect(mockPrisma.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 3000, type: "fund_allocate", refFundTxnId: "ft1" },
    });
  });

  it("applyFundTxn_cashback_incrementsWalletAndLogsTxnWithStatementRef", async () => {
    await applyFundTxn({ id: "ft1", type: "cashback", amountYen: 800, walletId: "w1", note: "sale 8%" });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 800 } } });
    expect(mockPrisma.walletTxn.create).toHaveBeenCalledWith({
      data: { id: expect.any(String), walletId: "w1", amount: 800, type: "cashback", statementRef: "sale 8%", refFundTxnId: "ft1" },
    });
  });

  it("applyFundTxn_unknownType_makesNoWrites", async () => {
    await applyFundTxn({ id: "ft1", type: "bogus", amountYen: 100, walletId: null, note: null });
    expect(mockPrisma.fund.update).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTxn.create).not.toHaveBeenCalled();
  });
});

describe("reverseFundTxn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reverseFundTxn_topup_decrementsFundBalance", async () => {
    await reverseFundTxn({ id: "ft1", type: "topup", amountYen: 5000, walletId: null, prevBalance: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { decrement: 5000 } } });
  });

  it("reverseFundTxn_set_restoresPrevBalance", async () => {
    await reverseFundTxn({ id: "ft1", type: "set", amountYen: 12000, walletId: null, prevBalance: "9000" });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: 9000 } });
  });

  it("reverseFundTxn_allocate_incrementsFundDecrementsWalletAndDeletesLinkedTxn", async () => {
    await reverseFundTxn({ id: "ft1", type: "allocate", amountYen: 3000, walletId: "w1", prevBalance: null });
    expect(mockPrisma.fund.update).toHaveBeenCalledWith({ where: { id: "main" }, data: { balance: { increment: 3000 } } });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 3000 } } });
    expect(mockPrisma.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refFundTxnId: "ft1" } });
  });

  it("reverseFundTxn_cashback_decrementsWalletAndDeletesLinkedTxn", async () => {
    await reverseFundTxn({ id: "ft1", type: "cashback", amountYen: 800, walletId: "w1", prevBalance: null });
    expect(mockPrisma.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 800 } } });
    expect(mockPrisma.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refFundTxnId: "ft1" } });
  });

  it("reverseFundTxn_unknownType_makesNoWrites", async () => {
    await reverseFundTxn({ id: "ft1", type: "bogus", amountYen: 100, walletId: null, prevBalance: null });
    expect(mockPrisma.fund.update).not.toHaveBeenCalled();
    expect(mockPrisma.wallet.update).not.toHaveBeenCalled();
    expect(mockPrisma.walletTxn.deleteMany).not.toHaveBeenCalled();
  });
});
