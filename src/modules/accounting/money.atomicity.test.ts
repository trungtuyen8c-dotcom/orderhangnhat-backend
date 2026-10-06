import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake DB trong bộ nhớ có ngữ nghĩa transaction: $transaction chụp state, callback throw -> khôi phục state.
// Ghi ngoài transaction (trừ audit/log) -> throw, để chứng minh mọi thao tác tiền đi qua 1 transaction.
type Row = Record<string, any>;
type State = {
  wallets: Row[]; walletTxns: Row[]; payments: Row[]; orders: Row[]; debts: Row[]; customers: Row[];
  deposits: Row[]; fund: Row[]; fundTxns: Row[]; audits: Row[];
};

const h = vi.hoisted(() => {
  const ctx: { state: any; inTx: boolean; failOn: { op: string; nth: number } | null; calls: Record<string, number> } = {
    state: null, inTx: false, failOn: null, calls: {},
  };
  const match = (row: any, where: any = {}) =>
    Object.entries(where).every(([k, v]: [string, any]) => {
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
      return row[k] === v;
    });
  const applyData = (row: any, data: any) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && ("increment" in (v as any) || "decrement" in (v as any))) {
        row[k] = Number(row[k] ?? 0) + Number((v as any).increment ?? 0) - Number((v as any).decrement ?? 0);
      } else row[k] = v;
    }
    return row;
  };
  const guard = (op: string, write: boolean) => {
    if (write && !ctx.inTx && op !== "accessAudit.create") throw new Error(`write outside transaction: ${op}`);
    ctx.calls[op] = (ctx.calls[op] ?? 0) + 1;
    if (ctx.failOn && ctx.failOn.op === op && ctx.calls[op] === ctx.failOn.nth) throw new Error(`injected failure: ${op}`);
  };
  const notFound = () => Object.assign(new Error("Record not found"), { code: "P2025" });
  const model = (name: string, table: string) => {
    const rows = () => ctx.state[table] as any[];
    const op = (m: string, write: boolean, fn: (...a: any[]) => any) => async (...a: any[]) => { guard(`${name}.${m}`, write); return fn(...a); };
    return {
      findUnique: op("findUnique", false, ({ where, include }: any) => {
        const r = rows().find((x) => match(x, where));
        if (!r) return null;
        return include?.payments ? { ...r, payments: ctx.state.payments.filter((p: any) => p.orderId === r.id) } : { ...r };
      }),
      findFirst: op("findFirst", false, ({ where }: any) => { const r = rows().find((x) => match(x, where)); return r ? { ...r } : null; }),
      findMany: op("findMany", false, ({ where }: any = {}) => rows().filter((x) => match(x, where)).map((x) => ({ ...x }))),
      count: op("count", false, ({ where }: any = {}) => rows().filter((x) => match(x, where)).length),
      create: op("create", true, ({ data }: any) => { const r = { id: data.id ?? `gen-${Math.random()}`, createdAt: new Date(), ...data }; rows().push(r); return { ...r }; }),
      update: op("update", true, ({ where, data }: any) => { const r = rows().find((x) => match(x, where)); if (!r) throw notFound(); return { ...applyData(r, data) }; }),
      updateMany: op("updateMany", true, ({ where, data }: any) => { const rs = rows().filter((x) => match(x, where)); rs.forEach((r) => applyData(r, data)); return { count: rs.length }; }),
      upsert: op("upsert", true, ({ where, create }: any) => { let r = rows().find((x) => match(x, where)); if (!r) { r = { ...create }; rows().push(r); } return { ...r }; }),
      delete: op("delete", true, ({ where }: any) => { const i = rows().findIndex((x) => match(x, where)); if (i < 0) throw notFound(); return rows().splice(i, 1)[0]; }),
      deleteMany: op("deleteMany", true, ({ where }: any) => { const keep = rows().filter((x) => !match(x, where)); const n = rows().length - keep.length; ctx.state[table] = keep; return { count: n }; }),
    };
  };
  const db: any = {
    wallet: model("wallet", "wallets"), walletTxn: model("walletTxn", "walletTxns"), payment: model("payment", "payments"),
    order: model("order", "orders"), debt: model("debt", "debts"), customer: model("customer", "customers"),
    customerDeposit: model("customerDeposit", "deposits"), fund: model("fund", "fund"), fundTxn: model("fundTxn", "fundTxns"),
    accessAudit: model("accessAudit", "audits"),
    permission: { count: async () => 0 },
    $queryRaw: async () => [],
  };
  db.$transaction = async (fn: (tx: any) => Promise<any>) => {
    const snapshot = structuredClone(ctx.state);
    ctx.inTx = true;
    try { return await fn(db); } catch (e) { ctx.state = snapshot; throw e; } finally { ctx.inTx = false; }
  };
  return { ctx, db };
});

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: h.db }));
vi.mock("../../app/audit.js", async (orig) => ({ ...(await orig<typeof import("../../app/audit.js")>()), logAudit: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueAccountingSheetSync: vi.fn() }));

import { eventBus } from "../../app/events/EventBus.js";
import { AppError } from "../../app/errors/AppError.js";
import { queueAccountingSheetSync } from "../sheets/sheet.jobs.js";
import { recordPayment } from "./payment.service.js";
import { confirmDeposit, deleteDeposit, editDeposit, unconfirmDeposit } from "./deposit.service.js";
import { deleteCardTxn, recordCardTxn, transfer } from "./card.service.js";
import { confirmFundTxn } from "./fund.service.js";
import { deleteWallet } from "./wallet.service.js";
import { applyOrderCardCharges } from "./orderCard.js";

const actor = { id: "u1", roles: ["accountant"] };
const W_VND = "00000000-0000-0000-0000-00000000000a";
const W_VND2 = "00000000-0000-0000-0000-00000000000b";
const W_JPY = "00000000-0000-0000-0000-00000000000c";
const INITIAL: Record<string, number> = { [W_VND]: 1000, [W_VND2]: 0, [W_JPY]: 5000 };

function seed(): State {
  return {
    wallets: [
      { id: W_VND, name: "VCB", currency: "VND", balance: INITIAL[W_VND] },
      { id: W_VND2, name: "TCB", currency: "VND", balance: INITIAL[W_VND2] },
      { id: W_JPY, name: "Rakuten", currency: "JPY", balance: INITIAL[W_JPY] },
    ],
    walletTxns: [], payments: [], debts: [], audits: [],
    orders: [{ id: "o1", customerId: "c1", code: "A1", totalVnd: 2000, totalQuote: 0, deposit: 0, paidAt: null, exchangeRate: null }],
    customers: [{ id: "c1", name: "Khach" }],
    deposits: [], fund: [{ id: "main", balance: 10000 }], fundTxns: [],
  };
}

const st = () => h.ctx.state as State;
const bal = (id: string) => Number(st().wallets.find((w) => w.id === id)!.balance);
// Bất biến: số dư ví = số dư ban đầu + tổng các dòng sổ WalletTxn của ví đó.
function expectLedgerConsistent() {
  for (const w of st().wallets) {
    const sum = st().walletTxns.filter((t) => t.walletId === w.id).reduce((s, t) => s + Number(t.amount), 0);
    expect(Number(w.balance)).toBe(INITIAL[w.id] + sum);
  }
}

let publish: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.ctx.state = seed();
  h.ctx.failOn = null;
  h.ctx.calls = {};
  vi.clearAllMocks();
  publish = vi.spyOn(eventBus, "publish").mockImplementation(() => {});
});

describe("recordPayment", () => {
  it("recordPayment_depositIntoWallet_updatesPaymentOrderWalletDebtAndAuditTogether", async () => {
    // Given đơn o1 + ví VND số dư 1000
    // When ghi cọc 500 vào ví
    const r = await recordPayment("o1", { type: "deposit", amount: 500, currency: "VND", walletId: W_VND }, actor);
    // Then payment, cọc đơn, ví + dòng sổ, công nợ, audit đều có
    expect(r.payment.amountVnd).toBe(500);
    expect(st().orders[0].deposit).toBe(500);
    expect(bal(W_VND)).toBe(1500);
    expect(st().walletTxns).toHaveLength(1);
    expect(st().walletTxns[0]).toMatchObject({ walletId: W_VND, amount: 500, type: "deposit", refOrderId: "o1" });
    expect(r.debt).not.toBeNull();
    expect(st().audits.map((a) => a.action)).toEqual(["payment.deposit"]);
    expectLedgerConsistent();
    expect(queueAccountingSheetSync).toHaveBeenCalledWith("c1");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "payment.created" }));
  });

  it("recordPayment_walletTxnCreateFails_rollsBackEverythingAndSkipsSideEffects", async () => {
    // Given ghi dòng sổ ví sẽ lỗi
    h.ctx.failOn = { op: "walletTxn.create", nth: 1 };
    // When ghi cọc vào ví
    await expect(recordPayment("o1", { type: "deposit", amount: 500, currency: "VND", walletId: W_VND }, actor)).rejects.toThrow("injected failure");
    // Then không còn payment, cọc đơn, số dư ví, audit nào; không sync sheet, không event
    expect(st().payments).toHaveLength(0);
    expect(st().orders[0].deposit).toBe(0);
    expect(bal(W_VND)).toBe(1000);
    expect(st().audits).toHaveLength(0);
    expect(queueAccountingSheetSync).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("recordPayment_debtRecomputeFails_walletBalanceNotChanged", async () => {
    h.ctx.failOn = { op: "debt.create", nth: 1 };
    await expect(recordPayment("o1", { type: "final", amount: 300, currency: "VND", walletId: W_VND }, actor)).rejects.toThrow();
    expect(bal(W_VND)).toBe(1000);
    expect(st().walletTxns).toHaveLength(0);
    expect(st().payments).toHaveLength(0);
  });

  it("recordPayment_refundWithoutPermission_returns403AndWritesNothing", async () => {
    const err = await recordPayment("o1", { type: "refund", amount: 100, currency: "VND", walletId: W_VND }, { id: "u2", roles: ["sale"] }).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.toBody()).toEqual({ error: "FORBIDDEN", message: "Thiếu quyền accounting.refund" });
    expect(err.status).toBe(403);
    expect(st().payments).toHaveLength(0);
    expect(bal(W_VND)).toBe(1000);
  });

  it("recordPayment_walletCurrencyMismatch_returns400WithLegacyMessage", async () => {
    const err = await recordPayment("o1", { type: "deposit", amount: 100, currency: "VND", walletId: W_JPY }, actor).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.toBody()).toEqual({ error: "CURRENCY_MISMATCH", message: "Ví Rakuten là JPY, không nhận VND" });
    expect(st().payments).toHaveLength(0);
  });

  it("recordPayment_refundFromWallet_decrementsWalletWithNegativeTxn", async () => {
    await recordPayment("o1", { type: "refund", amount: 200, currency: "VND", walletId: W_VND }, actor);
    expect(bal(W_VND)).toBe(800);
    expect(st().walletTxns[0].amount).toBe(-200);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "payment.refunded" }));
    expectLedgerConsistent();
  });
});

describe("customer deposit 2-step", () => {
  const addDeposit = (over: Row = {}) => {
    st().deposits.push({ id: "d1", customerId: "c1", amountVnd: 700, amountOrig: 700, currency: "VND", exchangeRate: null, walletId: W_VND, payerName: "A", confirmed: false, paidAt: new Date(), ...over });
  };

  it("confirmDeposit_calledTwice_creditsWalletOnlyOnce", async () => {
    // Given cọc chờ 700 vào ví VND
    addDeposit();
    // When kế toán bấm xác nhận 2 lần
    const first = await confirmDeposit("d1", actor);
    const second = await confirmDeposit("d1", actor);
    // Then ví chỉ cộng 1 lần, 1 dòng sổ, 1 audit, 1 event
    expect(first.confirmed).toBe(true);
    expect(second.confirmed).toBe(true);
    expect(bal(W_VND)).toBe(1700);
    expect(st().walletTxns).toHaveLength(1);
    expect(st().walletTxns[0]).toMatchObject({ amount: 700, type: "customer_deposit", category: "Cọc khách", note: "A", refDepositId: "d1" });
    expect(st().audits.filter((a) => a.action === "customer.deposit_confirmed")).toHaveLength(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(queueAccountingSheetSync).toHaveBeenCalledTimes(1);
    expectLedgerConsistent();
  });

  it("confirmDeposit_walletTxnFails_depositStaysPendingAndBalanceUnchanged", async () => {
    addDeposit();
    h.ctx.failOn = { op: "walletTxn.create", nth: 1 };
    await expect(confirmDeposit("d1", actor)).rejects.toThrow();
    expect(st().deposits[0].confirmed).toBe(false);
    expect(bal(W_VND)).toBe(1000);
    expect(publish).not.toHaveBeenCalled();
  });

  it("confirmDeposit_missing_throws404NotFound", async () => {
    const err = await confirmDeposit("nope", actor).catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.toBody()).toEqual({ error: "NOT_FOUND" });
  });

  it("unconfirmDeposit_confirmed_removesWalletTxnAndRestoresBalance", async () => {
    addDeposit();
    await confirmDeposit("d1", actor);
    const r = await unconfirmDeposit("d1", actor);
    expect(r.confirmed).toBe(false);
    expect(bal(W_VND)).toBe(1000);
    expect(st().walletTxns).toHaveLength(0);
    expectLedgerConsistent();
  });

  it("editDeposit_confirmedAmountChanged_adjustsWalletByDiffAndLinkedTxn", async () => {
    addDeposit();
    await confirmDeposit("d1", actor);
    await editDeposit("d1", { amount: 1000 }, actor);
    expect(bal(W_VND)).toBe(2000);
    expect(st().walletTxns[0].amount).toBe(1000);
    expect(st().deposits[0].amountVnd).toBe(1000);
    expectLedgerConsistent();
  });

  it("editDeposit_jpyWithoutRate_returns400AndChangesNothing", async () => {
    addDeposit();
    const err = await editDeposit("d1", { currency: "JPY" }, actor).catch((e) => e);
    expect(err.toBody()).toEqual({ error: "BAD_REQUEST", message: "Cọc JPY cần nhập tỉ giá" });
    expect(st().deposits[0].currency).toBe("VND");
  });

  it("deleteDeposit_finalDeleteFails_walletReversalRolledBack", async () => {
    addDeposit();
    await confirmDeposit("d1", actor);
    h.ctx.failOn = { op: "customerDeposit.delete", nth: 1 };
    await expect(deleteDeposit("d1", actor)).rejects.toThrow();
    expect(bal(W_VND)).toBe(1700);
    expect(st().walletTxns).toHaveLength(1);
    expect(st().deposits).toHaveLength(1);
    expectLedgerConsistent();
  });

  it("deleteDeposit_confirmed_reversesWalletAndDeletes", async () => {
    addDeposit();
    await confirmDeposit("d1", actor);
    await deleteDeposit("d1", actor);
    expect(bal(W_VND)).toBe(1000);
    expect(st().deposits).toHaveLength(0);
    expect(st().walletTxns).toHaveLength(0);
  });
});

describe("card ledger / transfer", () => {
  it("recordCardTxn_outCategory_decrementsBalanceWithMatchingTxn", async () => {
    const r = await recordCardTxn({ walletId: W_JPY, category: "Phí dịch vụ", amount: 300 }, actor);
    expect(r.balance).toBe(4700);
    expect(r.txn.amount).toBe(-300);
    expectLedgerConsistent();
  });

  it("recordCardTxn_unknownCategory_returns400BadCategory", async () => {
    const err = await recordCardTxn({ walletId: W_JPY, category: "???", amount: 1 }, actor).catch((e) => e);
    expect(err.toBody()).toEqual({ error: "BAD_CATEGORY", message: "Loại giao dịch không hợp lệ" });
  });

  it("transfer_feeLegFails_rollsBackBothLegs", async () => {
    // Given dòng sổ thứ 3 (phí) lỗi
    h.ctx.failOn = { op: "walletTxn.create", nth: 3 };
    // When chuyển 400 + phí 10
    await expect(transfer({ fromWalletId: W_VND, toWalletId: W_VND2, amount: 400, fee: 10 }, actor)).rejects.toThrow();
    // Then 2 vế đã ghi cũng bị huỷ
    expect(bal(W_VND)).toBe(1000);
    expect(bal(W_VND2)).toBe(0);
    expect(st().walletTxns).toHaveLength(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it("transfer_withFee_movesMoneyInOneWriteAndDeleteReversesWholeGroup", async () => {
    await transfer({ fromWalletId: W_VND, toWalletId: W_VND2, amount: 400, fee: 10 }, actor);
    expect(bal(W_VND)).toBe(590);
    expect(bal(W_VND2)).toBe(400);
    expect(st().walletTxns).toHaveLength(3);
    expect(new Set(st().walletTxns.map((t) => t.transferRef)).size).toBe(1);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "wallet.transfer_completed" }));
    expectLedgerConsistent();

    await deleteCardTxn(st().walletTxns[1].id, actor);
    expect(bal(W_VND)).toBe(1000);
    expect(bal(W_VND2)).toBe(0);
    expect(st().walletTxns).toHaveLength(0);
  });

  it("transfer_currencyMismatch_returns400", async () => {
    const err = await transfer({ fromWalletId: W_VND, toWalletId: W_JPY, amount: 1 }, actor).catch((e) => e);
    expect(err.toBody().error).toBe("CURRENCY_MISMATCH");
  });

  it("transfer_sameWallet_returns400SameWallet", async () => {
    const err = await transfer({ fromWalletId: W_VND, toWalletId: W_VND, amount: 1 }, actor).catch((e) => e);
    expect(err.toBody()).toEqual({ error: "SAME_WALLET", message: "Thẻ nguồn và đích phải khác nhau" });
  });
});

describe("fund 2-step", () => {
  it("confirmFundTxn_allocateTwice_movesMoneyOnce", async () => {
    st().fundTxns.push({ id: "f1", type: "allocate", amountYen: 2000, walletId: W_JPY, note: null, confirmed: false });
    await confirmFundTxn("f1", actor);
    await confirmFundTxn("f1", actor);
    expect(Number(st().fund[0].balance)).toBe(8000);
    expect(bal(W_JPY)).toBe(7000);
    expect(st().walletTxns).toHaveLength(1);
    expectLedgerConsistent();
  });

  it("confirmFundTxn_walletTxnFails_fundBalanceAndFlagUnchanged", async () => {
    st().fundTxns.push({ id: "f1", type: "allocate", amountYen: 2000, walletId: W_JPY, note: null, confirmed: false });
    h.ctx.failOn = { op: "walletTxn.create", nth: 1 };
    await expect(confirmFundTxn("f1", actor)).rejects.toThrow();
    expect(Number(st().fund[0].balance)).toBe(10000);
    expect(bal(W_JPY)).toBe(5000);
    expect(st().fundTxns[0].confirmed).toBe(false);
  });
});

describe("deleteWallet", () => {
  it("deleteWallet_referencedByDeposit_returns409HasTxns", async () => {
    // Given ví chưa có dòng sổ nhưng có cọc khách trỏ tới (FK Restrict)
    st().deposits.push({ id: "d9", customerId: "c1", walletId: W_VND2, confirmed: false, amountVnd: 1 });
    const err = await deleteWallet(W_VND2, actor).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.toBody()).toEqual({ error: "HAS_TXNS", message: "Ví còn giao dịch, không xóa được" });
    expect(st().wallets).toHaveLength(3);
  });

  it("deleteWallet_referencedByFundTxn_returns409HasTxns", async () => {
    st().fundTxns.push({ id: "f9", type: "cashback", walletId: W_VND2, confirmed: false });
    const err = await deleteWallet(W_VND2, actor).catch((e) => e);
    expect(err.status).toBe(409);
  });

  it("deleteWallet_unreferenced_deletesAndAudits", async () => {
    await deleteWallet(W_VND2, actor);
    expect(st().wallets.map((w) => w.id)).not.toContain(W_VND2);
    expect(st().audits.map((a) => a.action)).toEqual(["wallet.deleted"]);
  });
});

describe("applyOrderCardCharges with root client", () => {
  it("applyOrderCardCharges_rootClient_runsInsideOwnTransaction", async () => {
    // Given client gốc (có $transaction) - fake DB chặn ghi ngoài transaction
    await applyOrderCardCharges(h.db, { orderId: "o1", code: "A1", items: [{ unitPriceJpy: 1000, qty: 1, paymentMethod: "Rakuten", purchaseDate: "2026-01-10" }] });
    // Then trừ thẻ thành công (đã chạy trong transaction) và sổ khớp số dư
    expect(bal(W_JPY)).toBe(4000);
    expectLedgerConsistent();
  });
});
