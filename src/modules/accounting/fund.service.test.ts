import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    order: { findUnique: vi.fn() },
    debt: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    fund: { update: vi.fn() },
    wallet: { update: vi.fn() },
    walletTxn: { create: vi.fn(), deleteMany: vi.fn() },
  },
}));

import { applyFundTxn, reverseFundTxn } from "./fund.service.js";
import { prisma } from "../../infrastructure/prisma.js";

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
