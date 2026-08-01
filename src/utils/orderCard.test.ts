import { describe, it, expect, vi } from "vitest";
import { applyOrderCardCharges, reverseOrderCardCharges } from "./orderCard.js";

function fakeDb() {
  return {
    wallet: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    walletTxn: { create: vi.fn(), findMany: vi.fn().mockResolvedValue([]), deleteMany: vi.fn() },
  };
}

describe("applyOrderCardCharges", () => {
  it("applyOrderCardCharges_itemsWithoutPaymentMethod_skipsThemNoDbCalls", async () => {
    const db = fakeDb();
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [{ unitPriceJpy: 1000, qty: 1, paymentMethod: null }],
    });
    expect(db.wallet.findMany).not.toHaveBeenCalled();
  });

  it("applyOrderCardCharges_jpyWallet_chargesSumDirectlyInJpy", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([{ id: "w1", name: "CardA", currency: "JPY" }]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [{ unitPriceJpy: 1000, qty: 2, paymentMethod: "CardA", purchaseDate: "2026-01-10" }],
    });
    expect(db.walletTxn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ walletId: "w1", amount: -2000 }),
    }));
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { decrement: 2000 } } });
  });

  it("applyOrderCardCharges_vndWalletWithExchangeRate_chargesRoundedVndAmount", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([{ id: "w2", name: "CardB", currency: "VND" }]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1", exchangeRate: 180.5,
      items: [{ unitPriceJpy: 1000, qty: 1, paymentMethod: "CardB", purchaseDate: "2026-01-10" }],
    });
    expect(db.walletTxn.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ walletId: "w2", amount: -180500 }),
    }));
  });

  it("applyOrderCardCharges_vndWalletNoExchangeRate_skipsCharge", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([{ id: "w2", name: "CardB", currency: "VND" }]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [{ unitPriceJpy: 1000, qty: 1, paymentMethod: "CardB", purchaseDate: "2026-01-10" }],
    });
    expect(db.walletTxn.create).not.toHaveBeenCalled();
  });

  it("applyOrderCardCharges_walletNotFound_skipsGroup", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [{ unitPriceJpy: 1000, qty: 1, paymentMethod: "Unknown", purchaseDate: "2026-01-10" }],
    });
    expect(db.walletTxn.create).not.toHaveBeenCalled();
  });

  it("applyOrderCardCharges_multipleItemsSamePaymentMethodAndDate_groupsAndSumsIntoOneCharge", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([{ id: "w1", name: "CardA", currency: "JPY" }]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [
        { unitPriceJpy: 1000, qty: 1, paymentMethod: "CardA", purchaseDate: "2026-01-10" },
        { unitPriceJpy: 500, qty: 2, paymentMethod: "CardA", purchaseDate: "2026-01-10" },
      ],
    });
    expect(db.walletTxn.create).toHaveBeenCalledTimes(1);
    expect(db.walletTxn.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -2000 }) }));
  });

  it("applyOrderCardCharges_zeroCharge_skipsCreatingTxn", async () => {
    const db = fakeDb();
    db.wallet.findMany.mockResolvedValue([{ id: "w1", name: "CardA", currency: "JPY" }]);
    await applyOrderCardCharges(db, {
      orderId: "o1", code: "C1",
      items: [{ unitPriceJpy: 0, qty: 1, paymentMethod: "CardA", purchaseDate: "2026-01-10" }],
    });
    expect(db.walletTxn.create).not.toHaveBeenCalled();
  });
});

describe("reverseOrderCardCharges", () => {
  it("reverseOrderCardCharges_existingAutoTxns_incrementsWalletBalanceAndDeletesTxns", async () => {
    const db = fakeDb();
    db.walletTxn.findMany.mockResolvedValue([{ walletId: "w1", amount: "-2000" }]);
    await reverseOrderCardCharges(db, "o1");
    expect(db.wallet.update).toHaveBeenCalledWith({ where: { id: "w1" }, data: { balance: { increment: 2000 } } });
    expect(db.walletTxn.deleteMany).toHaveBeenCalledWith({ where: { refOrderId: "o1", statementRef: "auto:order" } });
  });

  it("reverseOrderCardCharges_noAutoTxns_doesNotUpdateOrDelete", async () => {
    const db = fakeDb();
    db.walletTxn.findMany.mockResolvedValue([]);
    await reverseOrderCardCharges(db, "o1");
    expect(db.wallet.update).not.toHaveBeenCalled();
    expect(db.walletTxn.deleteMany).not.toHaveBeenCalled();
  });
});
