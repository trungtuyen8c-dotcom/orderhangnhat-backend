import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    payroll: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));

import { listPayroll, listStaff, createPayroll, togglePaid, deletePayroll } from "./payroll.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";

const mp = prisma as any;
const actor = { id: "u1", requestId: "r1" };

beforeEach(() => vi.clearAllMocks());

describe("listPayroll", () => {
  it("listPayroll_mixedPaidRows_splitsTotalIntoPaidAndUnpaid", async () => {
    mp.payroll.findMany.mockResolvedValue([
      { amountVnd: "5000000", paid: true },
      { amountVnd: "3000000", paid: false },
      { amountVnd: "2000000", paid: true },
    ]);
    const r = await listPayroll("2026-03");
    expect([r.totalVnd, r.paidVnd, r.unpaidVnd]).toEqual([10000000, 7000000, 3000000]);
  });

  it("listPayroll_withMonth_filtersByMonth", async () => {
    mp.payroll.findMany.mockResolvedValue([]);
    await listPayroll("2026-03");
    expect(mp.payroll.findMany.mock.calls[0][0].where).toEqual({ month: "2026-03" });
  });

  it("listPayroll_noMonth_noFilterAndZeroTotals", async () => {
    mp.payroll.findMany.mockResolvedValue([]);
    const r = await listPayroll();
    expect(mp.payroll.findMany.mock.calls[0][0].where).toEqual({});
    expect([r.totalVnd, r.paidVnd, r.unpaidVnd]).toEqual([0, 0, 0]);
  });
});

describe("listStaff", () => {
  it("listStaff_userWithoutFullName_fallsBackToEmailAsName", async () => {
    mp.user.findMany.mockResolvedValue([{ id: "a", fullName: null, email: "a@x.vn" }, { id: "b", fullName: "Bình", email: "b@x.vn" }]);
    expect((await listStaff()).map((u) => u.name)).toEqual(["a@x.vn", "Bình"]);
  });
});

describe("createPayroll", () => {
  it("createPayroll_noUserIdOrNote_storesNulls", async () => {
    mp.payroll.create.mockResolvedValue({ id: "p1" });
    await createPayroll({ name: "Lan", month: "2026-03", amountVnd: 8000000 }, actor);
    expect(mp.payroll.create.mock.calls[0][0].data).toMatchObject({ userId: null, name: "Lan", month: "2026-03", amountVnd: 8000000, note: null });
  });

  it("createPayroll_success_auditsPayrollCreated", async () => {
    mp.payroll.create.mockResolvedValue({ id: "p1" });
    await createPayroll({ userId: "s1", name: "Lan", month: "2026-03", amountVnd: 1, note: "x" }, actor);
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", targetId: "p1", action: "payroll.created", requestId: "r1", entity: "payroll" });
  });
});

describe("togglePaid", () => {
  const NOW = new Date("2026-03-05T03:00:00.000Z");
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it("togglePaid_unknownId_throws404NotFound", async () => {
    mp.payroll.findUnique.mockResolvedValue(null);
    await expect(togglePaid("p1", actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(mp.payroll.update).not.toHaveBeenCalled();
  });

  it("togglePaid_unpaidRow_marksPaidWithPaidAtNow", async () => {
    mp.payroll.findUnique.mockResolvedValue({ id: "p1", paid: false });
    mp.payroll.update.mockResolvedValue({ id: "p1", paid: true });
    await togglePaid("p1", actor);
    expect(mp.payroll.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { paid: true, paidAt: NOW } });
  });

  it("togglePaid_paidRow_marksUnpaidAndClearsPaidAt", async () => {
    mp.payroll.findUnique.mockResolvedValue({ id: "p1", paid: true });
    mp.payroll.update.mockResolvedValue({ id: "p1", paid: false });
    await togglePaid("p1", actor);
    expect(mp.payroll.update).toHaveBeenCalledWith({ where: { id: "p1" }, data: { paid: false, paidAt: null } });
  });

  it("togglePaid_success_auditsBeforeAndAfterPaidState", async () => {
    mp.payroll.findUnique.mockResolvedValue({ id: "p1", paid: false });
    mp.payroll.update.mockResolvedValue({ id: "p1", paid: true });
    await togglePaid("p1", actor);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "payroll.paid_toggled", before: { paid: false }, after: { paid: true } }));
  });
});

describe("deletePayroll", () => {
  it("deletePayroll_givenId_deletesAndAudits", async () => {
    await deletePayroll("p1", actor);
    expect(mp.payroll.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "p1", action: "payroll.deleted" }));
  });
});
