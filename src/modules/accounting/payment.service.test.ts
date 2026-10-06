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
vi.mock("../sheets/sheet.jobs.js", () => ({ queueAccountingSheetSync: vi.fn() }));

import { recomputeDebt } from "./payment.service.js";
import { prisma } from "../../infrastructure/prisma.js";

const mockPrisma = prisma as unknown as {
  order: { findUnique: ReturnType<typeof vi.fn> };
  debt: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  fund: { update: ReturnType<typeof vi.fn> };
  wallet: { update: ReturnType<typeof vi.fn> };
  walletTxn: { create: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};

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
