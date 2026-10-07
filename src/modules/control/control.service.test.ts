import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    carton: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    tracking: { updateMany: vi.fn(), count: vi.fn() },
    appConfig: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    debt: { groupBy: vi.fn() },
    order: { findMany: vi.fn(), count: vi.fn() },
    customer: { findMany: vi.fn() },
    customerDeposit: { count: vi.fn() },
    taxRowNote: { count: vi.fn() },
  };
  p.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(p) : Promise.all(arg)));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../app/events/EventBus.js", () => ({ eventBus: { publish: vi.fn() } }));

import {
  summarizeOverdueDebts, listCartons, updateCarton, deleteCarton, getDebtConfig, getStorageConfig, setStorageConfig,
  storageOverdueCount, overdueDebts, overview,
} from "./control.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";

const mp = prisma as any;

const NOW = new Date("2026-03-05T00:00:00Z").getTime();
const DAY = 86400000;
const cfg = { thresholdVnd: 100000, overdueDays: 30 };
const customers = [
  { id: "c1", name: "C1", code: null, phone: null },
  { id: "c2", name: "C2", code: null, phone: null },
  { id: "c3", name: "C3", code: null, phone: null },
  { id: "c4", name: "C4", code: null, phone: null },
  { id: "c5", name: "C5", code: null, phone: null },
  { id: "c6", name: "C6", code: null, phone: null },
];

describe("summarizeOverdueDebts", () => {
  it("summarizeOverdueDebts_vndDebtAboveThreshold_includesCustomer", () => {
    const debtAgg = [{ customerId: "c1", currency: "VND", _sum: { balance: "500000" } }];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list).toEqual([{ customerId: "c1", name: "C1", code: null, phone: null, balanceVnd: 500000, balanceJpy: 0, days: 0 }]);
  });

  // Regression: trước đây debt.groupBy lọc where:{currency:"VND"} nên nợ ¥ vô hình hoàn toàn dù nợ bao lâu.
  it("summarizeOverdueDebts_jpyOnlyDebtWithinOverdueDays_excludesCustomer", () => {
    const debtAgg = [{ customerId: "c2", currency: "JPY", _sum: { balance: "20000" } }];
    const oldest = new Map([["c2", new Date(NOW - 10 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([]);
  });

  it("summarizeOverdueDebts_jpyOnlyDebtPastOverdueDays_includesCustomer", () => {
    const debtAgg = [{ customerId: "c3", currency: "JPY", _sum: { balance: "20000" } }];
    const oldest = new Map([["c3", new Date(NOW - 40 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([{ customerId: "c3", name: "C3", code: null, phone: null, balanceVnd: 0, balanceJpy: 20000, days: 40 }]);
  });

  it("summarizeOverdueDebts_customerWithBothCurrencies_keepsThemSeparate", () => {
    const debtAgg = [
      { customerId: "c4", currency: "VND", _sum: { balance: "300000" } },
      { customerId: "c4", currency: "JPY", _sum: { balance: "15000" } },
    ];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list[0].balanceVnd).toBe(300000);
    expect(list[0].balanceJpy).toBe(15000);
  });

  it("summarizeOverdueDebts_belowThresholdAndNotOverdueDays_excludesCustomer", () => {
    const debtAgg = [{ customerId: "c5", currency: "VND", _sum: { balance: "50000" } }];
    const oldest = new Map([["c5", new Date(NOW - 5 * DAY)]]);
    const list = summarizeOverdueDebts(debtAgg, oldest, customers, cfg, NOW);
    expect(list).toEqual([]);
  });

  it("summarizeOverdueDebts_multipleCustomers_sortsByVndBalanceDescending", () => {
    const debtAgg = [
      { customerId: "c1", currency: "VND", _sum: { balance: "500000" } },
      { customerId: "c6", currency: "VND", _sum: { balance: "800000" } },
    ];
    const list = summarizeOverdueDebts(debtAgg, new Map(), customers, cfg, NOW);
    expect(list.map((r) => r.customerId)).toEqual(["c6", "c1"]);
  });
});

describe("listCartons", () => {
  beforeEach(() => vi.clearAllMocks());

  it("listCartons_withDeclaredWeight_sumsEffectiveKgAndComputesDiff", async () => {
    mp.carton.findMany.mockResolvedValue([{
      id: "k1", code: "GE 1", note: null, declaredWeightKg: "3",
      trackings: [{ jpWeightKg: "1", vnWeightKg: null }, { jpWeightKg: "9", vnWeightKg: "2.5" }],
    }]);
    const [c] = await listCartons();
    expect(c).toMatchObject({ declaredWeightKg: 3, actualKg: 3.5, diffKg: 0.5, count: 2 });
  });

  it("listCartons_noDeclaredWeight_diffIsNull", async () => {
    mp.carton.findMany.mockResolvedValue([{ id: "k1", code: "GE 1", note: null, declaredWeightKg: null, trackings: [] }]);
    const [c] = await listCartons();
    expect(c).toMatchObject({ declaredWeightKg: null, actualKg: 0, diffKg: null, count: 0 });
  });
});

describe("updateCarton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updateCarton_newElectronicsCount_resetsElectronicsConfirmation", async () => {
    await updateCarton("k1", { electronicsCount: 2 });
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { electronicsCount: 2, electronicsConfirmedAt: null } });
  });

  it("updateCarton_onlyNoteAndPackedDate_keepsConfirmationsAndParsesDate", async () => {
    await updateCarton("k1", { note: "x", packedDate: "2026-03-04" });
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { note: "x", packedDate: new Date("2026-03-04") } });
  });
});

describe("deleteCarton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteCarton_givenId_auditsCartonDeleted", async () => {
    await deleteCarton("k1", { id: "u1", requestId: "r1" });
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", targetId: "k1", action: "carton.deleted", requestId: "r1" });
  });
});

describe("getDebtConfig / storage config", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getDebtConfig_noRows_returnsDefaultsZeroAnd30Days", async () => {
    mp.appConfig.findMany.mockResolvedValue([]);
    expect(await getDebtConfig()).toEqual({ thresholdVnd: 0, overdueDays: 30 });
  });

  it("getDebtConfig_storedRows_parsesNumbers", async () => {
    mp.appConfig.findMany.mockResolvedValue([{ key: "debt_threshold_vnd", value: "500000" }, { key: "debt_overdue_days", value: "45" }]);
    expect(await getDebtConfig()).toEqual({ thresholdVnd: 500000, overdueDays: 45 });
  });

  it("getStorageConfig_noRow_defaults7Days", async () => {
    mp.appConfig.findUnique.mockResolvedValue(null);
    expect(await getStorageConfig()).toEqual({ overdueDays: 7 });
  });

  it("setStorageConfig_givenDays_upsertsAsString", async () => {
    await setStorageConfig({ overdueDays: 10 });
    expect(mp.appConfig.upsert).toHaveBeenCalledWith({ where: { key: "storage_overdue_days" }, update: { value: "10" }, create: { key: "storage_overdue_days", value: "10" } });
  });
});

describe("storageOverdueCount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("storageOverdueCount_configured3Days_usesCutoff3DaysAgoForStoredAtAndLegacyPackedAt", async () => {
    mp.appConfig.findUnique.mockResolvedValue({ value: "3" });
    mp.tracking.count.mockResolvedValue(4);
    expect(await storageOverdueCount()).toBe(4);
    const cut = new Date("2026-03-07T00:00:00Z");
    expect(mp.tracking.count.mock.calls[0][0].where.AND).toEqual([{ OR: [{ storedAt: { lt: cut } }, { AND: [{ storedAt: null }, { packedAt: { lt: cut } }] }] }]);
  });
});

describe("overdueDebts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-31T00:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("overdueDebts_multipleOrders_agesDebtFromOldestOrder", async () => {
    mp.appConfig.findMany.mockResolvedValue([{ key: "debt_threshold_vnd", value: "1000000" }, { key: "debt_overdue_days", value: "20" }]);
    mp.debt.groupBy.mockResolvedValue([{ customerId: "c1", currency: "VND", _sum: { balance: "100" } }]);
    mp.order.findMany.mockResolvedValue([
      { customerId: "c1", createdAt: new Date("2026-03-21T00:00:00Z") },
      { customerId: "c1", createdAt: new Date("2026-03-01T00:00:00Z") },
    ]);
    mp.customer.findMany.mockResolvedValue([{ id: "c1", name: "C1", code: "K1", phone: null }]);
    const r = await overdueDebts();
    expect(r.list).toEqual([{ customerId: "c1", name: "C1", code: "K1", phone: null, balanceVnd: 100, balanceJpy: 0, days: 30 }]);
  });
});

describe("overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mp.order.count.mockResolvedValue(0);
    mp.tracking.count.mockResolvedValue(0);
    mp.customerDeposit.count.mockResolvedValue(0);
    mp.taxRowNote.count.mockResolvedValue(0);
    mp.appConfig.findMany.mockResolvedValue([]);
    mp.appConfig.findUnique.mockResolvedValue(null);
    mp.debt.groupBy.mockResolvedValue([]);
    mp.order.findMany.mockResolvedValue([]);
    mp.customer.findMany.mockResolvedValue([]);
  });

  it("overview_cartonsOffByMoreThan100g_countedAsMismatch", async () => {
    mp.carton.findMany.mockResolvedValue([
      { declaredWeightKg: "5", trackings: [{ jpWeightKg: "5.5", vnWeightKg: null }] },
      { declaredWeightKg: "5", trackings: [{ jpWeightKg: "9", vnWeightKg: "5.05" }] },
    ]);
    const r = await overview();
    expect(r.cartonMismatch).toBe(1);
  });

  // BUG: control.service.ts:189 so sánh float - lệch đúng 0.1kg (1.1 vs 1.0) ra 0.10000000000000009 > 0.1 nên bị tính là lệch.
  it("overview_cartonOffByExactly100g_notCountedAsMismatch", async () => {
    mp.carton.findMany.mockResolvedValue([{ declaredWeightKg: "1", trackings: [{ jpWeightKg: "1.1", vnWeightKg: null }] }]);
    const r = await overview();
    expect(r.cartonMismatch).toBe(0);
  });

  it("overview_taxPending_sumsTrackingAndNameRowCounts", async () => {
    mp.carton.findMany.mockResolvedValue([]);
    mp.tracking.count.mockImplementation(async (a: any) => (a?.where?.needsTax ? 3 : 0));
    mp.taxRowNote.count.mockResolvedValue(2);
    const r = await overview();
    expect(r.taxPending).toBe(5);
  });

  it("overview_lateOrders_countedSeparatelyPerSource", async () => {
    mp.carton.findMany.mockResolvedValue([]);
    mp.order.count.mockImplementation(async (a: any) => ({ mercari: 1, yahoo: 2, normal: 3 } as Record<string, number>)[a?.where?.source] ?? 0);
    const r = await overview();
    expect([r.lateOrdersMercari, r.lateOrdersYahoo, r.lateOrdersNormal]).toEqual([1, 2, 3]);
  });
});
