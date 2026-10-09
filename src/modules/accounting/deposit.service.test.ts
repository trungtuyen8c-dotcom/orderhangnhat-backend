import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const db: any = {
    customer: { findUnique: vi.fn(), findMany: vi.fn() },
    wallet: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    customerDeposit: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), deleteMany: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
  };
  db.$transaction = vi.fn(async (fn: (tx: any) => Promise<any>) => fn(db));
  return { db };
});

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: h.db }));
vi.mock("../../app/audit.js", async (orig) => ({ ...(await orig<typeof import("../../app/audit.js")>()), logAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueAccountingSheetSync: vi.fn() }));
vi.mock("./accounting.repository.js", async (orig) => ({
  ...(await orig<typeof import("./accounting.repository.js")>()),
  lockDeposit: vi.fn(),
  lockCustomer: vi.fn(),
  writeAudit: vi.fn(),
}));
vi.mock("./wallet.service.js", () => ({
  postWalletTxn: vi.fn(),
  reverseWalletTxns: vi.fn(),
  adjustDepositWalletTxn: vi.fn(),
}));

import { logAudit } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { eventBus } from "../../app/events/EventBus.js";
import { queueAccountingSheetSync } from "../sheets/sheet.jobs.js";
import { lockCustomer, lockDeposit, writeAudit } from "./accounting.repository.js";
import { adjustDepositWalletTxn, postWalletTxn, reverseWalletTxns } from "./wallet.service.js";
import {
  confirmDeposit, createDeposit, deleteDeposit, depositCounts, depositFixRequests, editDeposit, listDeposits,
  listOpeningBalances, requestDepositFix, resolveDepositFix, setOpeningBalance, unconfirmDeposit,
} from "./deposit.service.js";

const db = h.db;
const actor = { id: "u1", requestId: "r1" };
const NOW = new Date("2026-10-07T03:00:00.000Z");
let publish: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  publish = vi.spyOn(eventBus, "publish").mockImplementation(() => {});
  db.customerDeposit.create.mockImplementation(async ({ data }: any) => data);
  db.customerDeposit.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, customerId: "c1", amountVnd: 1000, walletId: "w1", ...data }));
});
afterEach(() => {
  publish.mockRestore();
  vi.useRealTimers();
});

const pendingDep = (over: Record<string, unknown> = {}) => ({
  id: "d1", customerId: "c1", amountVnd: "1000", amountOrig: "1000", currency: "VND", exchangeRate: null,
  walletId: "w1", payerName: "Lan", confirmed: false, ...over,
});

describe("createDeposit", () => {
  it("createDeposit_customerMissing_throws404AndCreatesNothing", async () => {
    db.customer.findUnique.mockResolvedValue(null);
    const err = await createDeposit("c1", { amount: 1000, currency: "VND" }, actor).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.customerDeposit.create).not.toHaveBeenCalled();
  });

  it("createDeposit_jpyWithoutRate_throws400BadRequest", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    const err = await createDeposit("c1", { amount: 1000, currency: "JPY" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST", status: 400 });
    expect(db.customerDeposit.create).not.toHaveBeenCalled();
  });

  it.each([
    { name: "integer rate", amount: 1000, rate: 172, expected: 172000 },
    { name: "fraction rounds up", amount: 3, rate: 172.5, expected: 518 },
    { name: "fraction rounds down", amount: 3, rate: 172.1, expected: 516 },
  ])("createDeposit_jpy $name_storesRoundedVndAmount", async ({ amount, rate, expected }) => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    await createDeposit("c1", { amount, currency: "JPY", exchangeRate: rate }, actor);
    expect(db.customerDeposit.create.mock.calls[0][0].data.amountVnd).toBe(expected);
  });

  it("createDeposit_walletMissing_throws404WalletNotFound", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    db.wallet.findUnique.mockResolvedValue(null);
    const err = await createDeposit("c1", { amount: 1000, currency: "VND", walletId: "w1" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "WALLET_NOT_FOUND", status: 404 });
  });

  it("createDeposit_jpyWallet_throws400CurrencyMismatch", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    db.wallet.findUnique.mockResolvedValue({ id: "w1", currency: "JPY" });
    const err = await createDeposit("c1", { amount: 1000, currency: "VND", walletId: "w1" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "CURRENCY_MISMATCH", status: 400 });
    expect(db.customerDeposit.create).not.toHaveBeenCalled();
  });

  it("createDeposit_minimalVndInput_createsPendingWithNullOptionalsAndNowPaidAt", async () => {
    vi.useFakeTimers({ now: NOW });
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    await createDeposit("c1", { amount: 1000, currency: "VND", payerName: "" }, actor);
    expect(db.customerDeposit.create).toHaveBeenCalledWith({
      data: {
        id: expect.any(String), customerId: "c1", amountVnd: 1000, currency: "VND", amountOrig: 1000, exchangeRate: null,
        payerName: null, method: null, walletId: null, note: null, paidAt: NOW, recordedBy: "u1",
      },
    });
  });

  it("createDeposit_success_doesNotTouchWallet", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    db.wallet.findUnique.mockResolvedValue({ id: "w1", currency: "VND" });
    await createDeposit("c1", { amount: 1000, currency: "VND", walletId: "w1" }, actor);
    expect(postWalletTxn).not.toHaveBeenCalled();
  });

  it("createDeposit_success_auditsUnconfirmedDeposit", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    await createDeposit("c1", { amount: 1000, currency: "VND" }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({
      targetId: "c1", action: "customer.deposit", metadata: { amountVnd: 1000, currency: "VND", confirmed: false },
    }));
  });

  it("createDeposit_success_publishesCreatedEventAndQueuesSheetSync", async () => {
    db.customer.findUnique.mockResolvedValue({ id: "c1" });
    const dep = await createDeposit("c1", { amount: 1000, currency: "VND" }, actor);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "deposit.created", entityId: dep.id, metadata: { customerId: "c1", amountVnd: 1000 },
    }));
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
  });
});

describe("confirmDeposit", () => {
  it("confirmDeposit_pendingWithWallet_creditsWalletWithDepositAmount", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await confirmDeposit("d1", actor);
    expect(postWalletTxn).toHaveBeenCalledWith(db, {
      walletId: "w1", amount: 1000, type: "customer_deposit", category: "Cọc khách", note: "Lan", refDepositId: "d1",
    });
  });

  it("confirmDeposit_pendingWithoutWallet_marksConfirmedWithoutWalletTxn", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ walletId: null }) as any);
    await confirmDeposit("d1", actor);
    expect(postWalletTxn).not.toHaveBeenCalled();
    expect(db.customerDeposit.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { confirmed: true, confirmedBy: "u1", confirmedAt: NOW } });
  });

  it("confirmDeposit_pending_auditsPublishesAndSyncs", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await confirmDeposit("d1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "c1", action: "customer.deposit_confirmed", metadata: { amountVnd: 1000 } }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "deposit.confirmed", entityId: "d1", metadata: { customerId: "c1", amountVnd: 1000, walletId: "w1" } }));
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
  });

  it("confirmDeposit_alreadyConfirmed_returnsCurrentWithoutSideEffects", async () => {
    const cur = pendingDep({ confirmed: true });
    vi.mocked(lockDeposit).mockResolvedValue(cur as any);
    const r = await confirmDeposit("d1", actor);
    expect(r).toBe(cur);
    expect(db.customerDeposit.update).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(queueAccountingSheetSync).not.toHaveBeenCalled();
  });
});

describe("unconfirmDeposit", () => {
  it("unconfirmDeposit_missing_throws404", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(null);
    const err = await unconfirmDeposit("d1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("unconfirmDeposit_pending_noReversalAuditOrSync", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await unconfirmDeposit("d1", actor);
    expect(reverseWalletTxns).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
    expect(queueAccountingSheetSync).not.toHaveBeenCalled();
  });

  it("unconfirmDeposit_confirmed_resetsFlagsReversesLinkedTxnAndAudits", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ confirmed: true }) as any);
    await unconfirmDeposit("d1", actor);
    expect(db.customerDeposit.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { confirmed: false, confirmedBy: null, confirmedAt: null } });
    expect(reverseWalletTxns).toHaveBeenCalledWith(db, { refDepositId: "d1" });
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ action: "customer.deposit_unconfirmed" }));
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
  });
});

describe("editDeposit", () => {
  it("editDeposit_missing_throws404", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(null);
    const err = await editDeposit("d1", { note: "x" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("editDeposit_textFieldsOnly_blankToNullAndNoMoneyFields", async () => {
    const paidAt = new Date("2026-10-01T00:00:00.000Z");
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await editDeposit("d1", { payerName: "", method: "bank", note: "", paidAt }, actor);
    expect(db.customerDeposit.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { payerName: null, method: "bank", note: null, paidAt } });
  });

  it("editDeposit_jpyWithRate_storesRoundedVndAmount", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await editDeposit("d1", { amount: 3, currency: "JPY", exchangeRate: 172.5 }, actor);
    expect(db.customerDeposit.update.mock.calls[0][0].data).toMatchObject({ currency: "JPY", amountOrig: 3, exchangeRate: 172.5, amountVnd: 518 });
  });

  it("editDeposit_jpyAmountOnly_reusesStoredRate", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ currency: "JPY", amountOrig: "10", exchangeRate: "170", amountVnd: "1700" }) as any);
    await editDeposit("d1", { amount: 20 }, actor);
    expect(db.customerDeposit.update.mock.calls[0][0].data).toMatchObject({ currency: "JPY", amountOrig: 20, exchangeRate: 170, amountVnd: 3400 });
  });

  it("editDeposit_pendingAmountChanged_doesNotTouchWallet", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await editDeposit("d1", { amount: 1500 }, actor);
    expect(adjustDepositWalletTxn).not.toHaveBeenCalled();
  });

  it("editDeposit_confirmedWithoutWallet_doesNotTouchWallet", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ confirmed: true, walletId: null }) as any);
    await editDeposit("d1", { amount: 1500 }, actor);
    expect(adjustDepositWalletTxn).not.toHaveBeenCalled();
  });

  it("editDeposit_confirmedSameAmount_doesNotTouchWallet", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ confirmed: true }) as any);
    await editDeposit("d1", { amount: 1000 }, actor);
    expect(adjustDepositWalletTxn).not.toHaveBeenCalled();
  });

  it("editDeposit_confirmedAmountDecreased_adjustsWalletByNegativeDiff", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ confirmed: true }) as any);
    await editDeposit("d1", { amount: 600 }, actor);
    expect(adjustDepositWalletTxn).toHaveBeenCalledWith(db, "w1", "d1", -400, 600);
  });

  it("editDeposit_any_auditsWithInputAsMetadata", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await editDeposit("d1", { note: "x" }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "d1", action: "customer_deposit.updated", metadata: { note: "x" } }));
  });
});

describe("deleteDeposit", () => {
  it("deleteDeposit_missing_throws404AndDeletesNothing", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(null);
    const err = await deleteDeposit("d1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.customerDeposit.delete).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("deleteDeposit_pending_reversesLinkedTxnsAndDeletes", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep() as any);
    await deleteDeposit("d1", actor);
    expect(reverseWalletTxns).toHaveBeenCalledWith(db, { refDepositId: "d1" });
    expect(db.customerDeposit.delete).toHaveBeenCalledWith({ where: { id: "d1" } });
  });

  it("deleteDeposit_success_auditsPublishesAndSyncs", async () => {
    vi.mocked(lockDeposit).mockResolvedValue(pendingDep({ confirmed: true }) as any);
    await deleteDeposit("d1", actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "c1", action: "customer.deposit_deleted" }));
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "deposit.deleted", entityId: "d1", metadata: { customerId: "c1", amountVnd: 1000, confirmed: true } }));
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
  });
});

describe("listDeposits", () => {
  beforeEach(() => {
    db.customerDeposit.findMany.mockResolvedValue([]);
    db.customer.findMany.mockResolvedValue([]);
    db.user.findMany.mockResolvedValue([]);
  });

  it.each([
    { status: undefined, where: { isOpening: false, confirmed: false } },
    { status: "pending", where: { isOpening: false, confirmed: false } },
    { status: "confirmed", where: { isOpening: false, confirmed: true } },
    { status: "fix_request", where: { isOpening: false, fixRequest: { not: null } } },
    { status: "all", where: { isOpening: false } },
  ])("listDeposits_status $status_filtersByStatus", async ({ status, where }) => {
    await listDeposits({ status });
    expect(db.customerDeposit.findMany.mock.calls[0][0].where).toEqual(where);
  });

  it("listDeposits_fromAndTo_filtersPaidAtByVnDayBounds", async () => {
    await listDeposits({ status: "all", from: "2026-10-01", to: "2026-10-07" });
    expect(db.customerDeposit.findMany.mock.calls[0][0].where.paidAt).toEqual({
      gte: new Date("2026-09-30T17:00:00.000Z"), lte: new Date("2026-10-07T16:59:59.999Z"),
    });
  });

  it("listDeposits_fromOnly_filtersLowerBoundOnly", async () => {
    await listDeposits({ status: "all", from: "2026-10-01" });
    expect(db.customerDeposit.findMany.mock.calls[0][0].where.paidAt).toEqual({ gte: new Date("2026-09-30T17:00:00.000Z") });
  });

  it("listDeposits_rows_enrichesCustomerAndUserNames", async () => {
    db.customerDeposit.findMany.mockResolvedValue([{ id: "d1", customerId: "c1", recordedBy: "u1", confirmedBy: "u2" }]);
    db.customer.findMany.mockResolvedValue([{ id: "c1", name: "Lan", code: "K01" }]);
    db.user.findMany.mockResolvedValue([{ id: "u1", fullName: "Mai", email: "m@x" }, { id: "u2", fullName: null, email: "k@x" }]);
    const [r] = await listDeposits({});
    expect(r).toMatchObject({ customerName: "Lan", customerCode: "K01", recordedByName: "Mai", confirmedByName: "k@x" });
  });

  it("listDeposits_unknownCustomerAndNoConfirmer_fallsBackToPlaceholders", async () => {
    db.customerDeposit.findMany.mockResolvedValue([{ id: "d1", customerId: "c9", recordedBy: "u9", confirmedBy: null }]);
    const [r] = await listDeposits({});
    expect(r).toMatchObject({ customerName: "?", customerCode: null, recordedByName: null, confirmedByName: null });
  });
});

describe("depositCounts", () => {
  it("depositCounts_counts_returnsNamedBuckets", async () => {
    db.customerDeposit.count.mockResolvedValueOnce(3).mockResolvedValueOnce(5).mockResolvedValueOnce(1).mockResolvedValueOnce(8);
    expect(await depositCounts()).toEqual({ pending: 3, confirmed: 5, fixRequest: 1, all: 8 });
  });
});

describe("requestDepositFix / resolveDepositFix", () => {
  it("requestDepositFix_missing_throws404", async () => {
    db.customerDeposit.findUnique.mockResolvedValue(null);
    const err = await requestDepositFix("d1", "sai tiền", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.customerDeposit.update).not.toHaveBeenCalled();
  });

  it("requestDepositFix_existing_storesNoteAndAudits", async () => {
    vi.useFakeTimers({ now: NOW });
    db.customerDeposit.findUnique.mockResolvedValue({ id: "d1" });
    await requestDepositFix("d1", "sai tiền", actor);
    expect(db.customerDeposit.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { fixRequest: "sai tiền", fixRequestedAt: NOW } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "d1", action: "customer_deposit.fix_requested", metadata: { note: "sai tiền" } }));
  });

  it("resolveDepositFix_missing_throws404", async () => {
    db.customerDeposit.findUnique.mockResolvedValue(null);
    const err = await resolveDepositFix("d1", actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("resolveDepositFix_existing_clearsRequestAndAudits", async () => {
    db.customerDeposit.findUnique.mockResolvedValue({ id: "d1" });
    await resolveDepositFix("d1", actor);
    expect(db.customerDeposit.update).toHaveBeenCalledWith({ where: { id: "d1" }, data: { fixRequest: null, fixRequestedAt: null } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "d1", action: "customer_deposit.fix_resolved" }));
  });
});

describe("depositFixRequests", () => {
  it("depositFixRequests_rows_mapsCustomerNameWithFallback", async () => {
    db.customerDeposit.findMany.mockResolvedValue([
      { id: "d1", customerId: "c1", fixRequest: "a" },
      { id: "d2", customerId: "c9", fixRequest: "b" },
    ]);
    db.customer.findMany.mockResolvedValue([{ id: "c1", name: "Lan" }]);
    expect(await depositFixRequests()).toEqual([
      { id: "d1", fixRequest: "a", customer: "Lan" },
      { id: "d2", fixRequest: "b", customer: "?" },
    ]);
  });
});

describe("listOpeningBalances", () => {
  it("listOpeningBalances_rows_convertsDecimalsToNumbers", async () => {
    db.customerDeposit.findMany.mockResolvedValue([
      { customerId: "c1", amountOrig: "-500", currency: "JPY", exchangeRate: "170", amountVnd: "-85000" },
      { customerId: "c2", amountOrig: "2000", currency: "VND", exchangeRate: null, amountVnd: "2000" },
    ]);
    expect(await listOpeningBalances()).toEqual([
      { customerId: "c1", amountOrig: -500, currency: "JPY", exchangeRate: 170, amountVnd: -85000 },
      { customerId: "c2", amountOrig: 2000, currency: "VND", exchangeRate: null, amountVnd: 2000 },
    ]);
  });
});

describe("setOpeningBalance", () => {
  it("setOpeningBalance_customerMissing_throws404", async () => {
    vi.mocked(lockCustomer).mockResolvedValue(null);
    const err = await setOpeningBalance("c1", { amount: 100, currency: "VND" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(db.customerDeposit.deleteMany).not.toHaveBeenCalled();
  });

  it("setOpeningBalance_jpyWithoutRate_throws400", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1" } as any);
    const err = await setOpeningBalance("c1", { amount: 100, currency: "JPY" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST", status: 400 });
    expect(db.customerDeposit.deleteMany).not.toHaveBeenCalled();
  });

  it("setOpeningBalance_zeroAmount_clearsExistingAndReturnsCleared", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1" } as any);
    const r = await setOpeningBalance("c1", { amount: 0, currency: "VND" }, actor);
    expect(r).toEqual({ cleared: true });
    expect(db.customerDeposit.deleteMany).toHaveBeenCalledWith({ where: { customerId: "c1", isOpening: true, currency: "VND" } });
    expect(db.customerDeposit.create).not.toHaveBeenCalled();
  });

  it("setOpeningBalance_negativeJpy_replacesWithConfirmedOpeningRowAtCutoff", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1" } as any);
    await setOpeningBalance("c1", { amount: -500, currency: "JPY", exchangeRate: 170 }, actor);
    expect(db.customerDeposit.deleteMany).toHaveBeenCalledWith({ where: { customerId: "c1", isOpening: true, currency: "JPY" } });
    expect(db.customerDeposit.create.mock.calls[0][0].data).toMatchObject({
      customerId: "c1", amountVnd: -85000, amountOrig: -500, currency: "JPY", note: "Số dư đầu kỳ",
      paidAt: new Date("2026-06-30T00:00:00.000Z"), confirmed: true, isOpening: true, recordedBy: "u1",
    });
  });

  it("setOpeningBalance_vndCustomerJpyWithoutRate_throws400", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1", payCurrency: "VND" } as any);
    const err = await setOpeningBalance("c1", { amount: 100, currency: "JPY" }, actor).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_REQUEST", status: 400 });
  });

  it("setOpeningBalance_jpyCustomerJpyWithoutRate_createsJpyOpeningWithZeroVnd", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1", payCurrency: "JPY" } as any);
    await setOpeningBalance("c1", { amount: 3000, currency: "JPY" }, actor);
    expect(db.customerDeposit.deleteMany).toHaveBeenCalledWith({ where: { customerId: "c1", isOpening: true, currency: "JPY" } });
    expect(db.customerDeposit.create.mock.calls[0][0].data).toMatchObject({ amountVnd: 0, amountOrig: 3000, currency: "JPY", exchangeRate: null, isOpening: true });
  });

  it("setOpeningBalance_jpyCustomerVndOpening_onlyReplacesVndRow", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1", payCurrency: "JPY" } as any);
    await setOpeningBalance("c1", { amount: 50000, currency: "VND" }, actor);
    expect(db.customerDeposit.deleteMany).toHaveBeenCalledWith({ where: { customerId: "c1", isOpening: true, currency: "VND" } });
    expect(db.customerDeposit.create.mock.calls[0][0].data).toMatchObject({ amountVnd: 50000, currency: "VND" });
  });

  it("setOpeningBalance_dateGiven_usedAsPaidAt", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1" } as any);
    const date = new Date("2026-07-15T00:00:00.000Z");
    await setOpeningBalance("c1", { amount: 1000, currency: "VND", date }, actor);
    expect(db.customerDeposit.create.mock.calls[0][0].data.paidAt).toEqual(date);
  });

  it("setOpeningBalance_success_auditsAndQueuesSync", async () => {
    vi.mocked(lockCustomer).mockResolvedValue({ id: "c1" } as any);
    await setOpeningBalance("c1", { amount: 2000, currency: "VND" }, actor);
    expect(writeAudit).toHaveBeenCalledWith(db, expect.objectContaining({ targetId: "c1", action: "customer.opening_balance", metadata: { amountVnd: 2000 } }));
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
  });
});
