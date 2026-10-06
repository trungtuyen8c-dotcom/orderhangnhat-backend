import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "u1" }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({ authorize: () => (_req: any, _res: any, next: any) => next() }));
vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    carton: { findUnique: vi.fn(), delete: vi.fn(), create: vi.fn(), update: vi.fn() },
    tracking: { updateMany: vi.fn() },
    appConfig: { upsert: vi.fn() },
  };
  p.$transaction = vi.fn(async (arg: any) => (typeof arg === "function" ? arg(p) : Promise.all(arg)));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../app/events/EventBus.js", () => ({ eventBus: { publish: vi.fn() } }));

import { controlRouter } from "./control.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { eventBus } from "../../app/events/EventBus.js";
import { logAudit } from "../../app/audit.js";

const mp = prisma as any;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/control", controlRouter);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe("control routes", () => {
  it("postCarton_valid_createsViaCartonServiceEmitsEventAndReturnsSameBody", async () => {
    // Given
    const row = { id: "k9", code: "BILL1", declaredWeightKg: 10, electronicsCount: null, packedDate: null, note: null };
    mp.carton.create.mockResolvedValue(row);
    // When
    const res = await request(buildApp()).post("/api/control/cartons").send({ code: "BILL1", declaredWeightKg: 10 });
    // Then
    expect(res.status).toBe(201);
    expect(res.body).toEqual(row);
    expect(mp.carton.create.mock.calls[0][0].data).toMatchObject({ code: "BILL1", declaredWeightKg: 10, electronicsCount: null, packedDate: null, note: null });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ actorId: "u1", targetId: "k9", action: "carton.created" }));
    expect(eventBus.publish).toHaveBeenCalledWith(expect.objectContaining({ eventName: "carton.created", entityId: "k9", metadata: { code: "BILL1" } }));
  });

  it("deleteCarton_detachesTrackingsAsManualThenDeletesInOneTransaction", async () => {
    const res = await request(buildApp()).delete("/api/control/cartons/k1");
    expect(res.body).toEqual({ ok: true });
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(mp.tracking.updateMany).toHaveBeenCalledWith({ where: { cartonId: "k1" }, data: { cartonId: null, cartonManual: true } });
    expect(mp.carton.delete).toHaveBeenCalledWith({ where: { id: "k1" } });
  });

  it("assign_unknownCarton_returns404", async () => {
    mp.carton.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post("/api/control/cartons/k1/assign").send({ codes: ["A"] });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });

  it("assign_trimsCodesAndMarksManual", async () => {
    mp.carton.findUnique.mockResolvedValue({ id: "k1" });
    mp.tracking.updateMany.mockResolvedValue({ count: 2 });
    const res = await request(buildApp()).post("/api/control/cartons/k1/assign").send({ codes: [" A ", "B", " "] });
    expect(res.body).toEqual({ assigned: 2 });
    expect(mp.tracking.updateMany).toHaveBeenCalledWith({ where: { code: { in: ["A", "B"] } }, data: { cartonId: "k1", cartonManual: true } });
  });

  it("patchCarton_newDeclaredWeight_resetsWeightConfirmation", async () => {
    mp.carton.update.mockResolvedValue({ id: "k1" });
    await request(buildApp()).patch("/api/control/cartons/k1").send({ declaredWeightKg: 12.5, packedDate: "" });
    expect(mp.carton.update.mock.calls[0][0].data).toEqual({ declaredWeightKg: 12.5, weightConfirmedAt: null, packedDate: null });
  });

  it("putDebtConfig_invalid_returns400BadRequest", async () => {
    const res = await request(buildApp()).put("/api/control/debt-config").send({ thresholdVnd: -1, overdueDays: 3 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("putDebtConfig_valid_writesBothKeysAtomically", async () => {
    const res = await request(buildApp()).put("/api/control/debt-config").send({ thresholdVnd: 100000, overdueDays: 30 });
    expect(res.body).toEqual({ thresholdVnd: 100000, overdueDays: 30 });
    expect(mp.appConfig.upsert).toHaveBeenCalledTimes(2);
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
  });
});
