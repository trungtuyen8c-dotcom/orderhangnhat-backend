import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    tracking: { count: vi.fn() },
    carton: { delete: vi.fn(), create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../app/events/EventBus.js", () => ({ eventBus: { publish: vi.fn() } }));

import { deleteCartonIfEmpty, createCarton, setVnTotalWeight, confirmWeight, setElectronicsCount, confirmElectronics } from "./carton.service.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";

const mockPrisma = prisma as unknown as {
  tracking: { count: ReturnType<typeof vi.fn> };
  carton: { delete: ReturnType<typeof vi.fn> };
};
const mp = prisma as any;
const actor = { id: "u1", requestId: "r1" };
const NOW = new Date("2026-03-05T03:00:00.000Z");

describe("deleteCartonIfEmpty", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deleteCartonIfEmpty_cartonIdNull_doesNothing", async () => {
    await deleteCartonIfEmpty(null);
    expect(mockPrisma.tracking.count).not.toHaveBeenCalled();
  });

  it("deleteCartonIfEmpty_cartonHasRemainingTrackings_doesNotDelete", async () => {
    mockPrisma.tracking.count.mockResolvedValue(3);
    await deleteCartonIfEmpty("c1");
    expect(mockPrisma.carton.delete).not.toHaveBeenCalled();
  });

  it("deleteCartonIfEmpty_cartonEmpty_deletesCarton", async () => {
    mockPrisma.tracking.count.mockResolvedValue(0);
    await deleteCartonIfEmpty("c1");
    expect(mockPrisma.carton.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("deleteCartonIfEmpty_deleteThrows_swallowsErrorWithoutThrowing", async () => {
    mockPrisma.tracking.count.mockResolvedValue(0);
    mockPrisma.carton.delete.mockRejectedValue(new Error("already deleted"));
    await expect(deleteCartonIfEmpty("c1")).resolves.toBeUndefined();
  });
});

describe("createCarton", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createCarton_packedDateString_storesDateAndNullsMissingOptionals", async () => {
    mp.carton.create.mockResolvedValue({ id: "k1", code: "GE 1" });
    await createCarton({ code: "GE 1", packedDate: "2026-03-04" }, actor);
    expect(mp.carton.create.mock.calls[0][0].data).toMatchObject({
      code: "GE 1", declaredWeightKg: null, electronicsCount: null, packedDate: new Date("2026-03-04"), note: null,
    });
  });
});

describe("setVnTotalWeight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("setVnTotalWeight_newTotal_resetsPreviousWeightConfirmation", async () => {
    mp.carton.update.mockResolvedValue({ id: "k1", declaredWeightKg: "5", vnTotalWeightKg: "5", weightConfirmedAt: null });
    await setVnTotalWeight("k1", 5, actor);
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { vnTotalWeightKg: 5, weightConfirmedAt: null } });
  });

  it("setVnTotalWeight_diffAtLeast1KgAfterUpdate_publishesCartonLocked", async () => {
    mp.carton.update.mockResolvedValue({ id: "k1", declaredWeightKg: "5", vnTotalWeightKg: "6.5", weightConfirmedAt: null });
    await setVnTotalWeight("k1", 6.5, actor);
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "carton.locked", entityId: "k1", metadata: { vnTotalWeightKg: 6.5 } }));
  });

  it("setVnTotalWeight_totalsWithinThreshold_doesNotPublishLocked", async () => {
    mp.carton.update.mockResolvedValue({ id: "k1", declaredWeightKg: "5", vnTotalWeightKg: "5.5", weightConfirmedAt: null });
    await setVnTotalWeight("k1", 5.5, actor);
    expect(eventBus.publish).not.toHaveBeenCalled();
  });
});

describe("confirmWeight", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirmWeight_unknownCarton_throws404NotFound", async () => {
    mp.carton.findUnique.mockResolvedValue(null);
    await expect(confirmWeight("k1", actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it.each([
    ["missingDeclared", { declaredWeightKg: null, vnTotalWeightKg: "5" }],
    ["missingVnTotal", { declaredWeightKg: "5", vnTotalWeightKg: null }],
  ])("confirmWeight_%s_throws400MissingTotalsWithoutUpdating", async (_name, row) => {
    mp.carton.findUnique.mockResolvedValue(row);
    await expect(confirmWeight("k1", actor)).rejects.toMatchObject({ status: 400, code: "MISSING_TOTALS" });
    expect(mp.carton.update).not.toHaveBeenCalled();
  });

  it("confirmWeight_bothTotalsPresent_setsConfirmedAtNow", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mp.carton.findUnique.mockResolvedValue({ declaredWeightKg: "5", vnTotalWeightKg: "7" });
    mp.carton.update.mockResolvedValue({ id: "k1" });
    await confirmWeight("k1", actor);
    vi.useRealTimers();
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { weightConfirmedAt: NOW } });
  });

  it("confirmWeight_success_auditsAndPublishesWithStringTotals", async () => {
    mp.carton.findUnique.mockResolvedValue({ declaredWeightKg: 5, vnTotalWeightKg: 7 });
    mp.carton.update.mockResolvedValue({ id: "k1" });
    await confirmWeight("k1", actor);
    const metadata = { declaredWeightKg: "5", vnTotalWeightKg: "7" };
    expect(logAudit).toHaveBeenCalledWith({ actorId: "u1", targetId: "k1", action: "carton.weight_confirmed", metadata, requestId: "r1" });
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "warehouse.weight_confirmed", entityId: "k1", metadata }));
  });
});

describe("setElectronicsCount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("setElectronicsCount_newCount_resetsElectronicsConfirmation", async () => {
    await setElectronicsCount("k1", 3);
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { electronicsCount: 3, electronicsConfirmedAt: null } });
  });
});

describe("confirmElectronics", () => {
  beforeEach(() => vi.clearAllMocks());

  it("confirmElectronics_unknownCarton_throws404NotFound", async () => {
    mp.carton.findUnique.mockResolvedValue(null);
    await expect(confirmElectronics("k1", actor)).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
  });

  it("confirmElectronics_countNotFilled_throws400MissingCount", async () => {
    mp.carton.findUnique.mockResolvedValue({ electronicsCount: null });
    await expect(confirmElectronics("k1", actor)).rejects.toMatchObject({ status: 400, code: "MISSING_COUNT" });
    expect(mp.carton.update).not.toHaveBeenCalled();
  });

  it("confirmElectronics_zeroCount_isValidAndAuditsConfirmation", async () => {
    mp.carton.findUnique.mockResolvedValue({ electronicsCount: 0 });
    mp.carton.update.mockResolvedValue({ id: "k1" });
    await confirmElectronics("k1", actor);
    expect(mp.carton.update).toHaveBeenCalledWith({ where: { id: "k1" }, data: { electronicsConfirmedAt: expect.any(Date) } });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ targetId: "k1", action: "carton.electronics_confirmed", metadata: { electronicsCount: "0" } }));
  });
});
