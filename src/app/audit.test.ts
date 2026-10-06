import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../infrastructure/prisma.js", () => ({ prisma: { accessAudit: { create: vi.fn() } } }));
vi.mock("../infrastructure/logger.js", () => ({ logger: { warn: vi.fn() } }));

import { buildAuditMetadata, logAudit, logAuditTx } from "./audit.js";
import { prisma } from "../infrastructure/prisma.js";
import { logger } from "../infrastructure/logger.js";

const mockCreate = (prisma as any).accessAudit.create as ReturnType<typeof vi.fn>;

describe("buildAuditMetadata", () => {
  it("buildAuditMetadata_noMetadataNoExtras_returnsUndefined", () => {
    expect(buildAuditMetadata({ action: "x" })).toBeUndefined();
  });

  it("buildAuditMetadata_extrasGiven_mergesRequestIdEntityBeforeAfterIntoMetadata", () => {
    expect(buildAuditMetadata({ action: "x", metadata: { key: "k" }, requestId: "r1", entity: "role", before: { a: 1 }, after: { a: 2 } }))
      .toEqual({ key: "k", requestId: "r1", entity: "role", before: { a: 1 }, after: { a: 2 } });
  });

  it("buildAuditMetadata_onlyMetadata_keepsMetadataUnchanged", () => {
    expect(buildAuditMetadata({ action: "x", metadata: { email: "a@b.c" } })).toEqual({ email: "a@b.c" });
  });
});

describe("logAudit", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logAudit_dbWriteFails_doesNotThrowAndLogsWarning", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));
    await expect(logAudit({ action: "auth.logout", requestId: "r1" })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.logout", request_id: "r1" }), "audit_write_failed");
  });

  it("logAudit_ok_writesNullsForMissingActorTargetIp", async () => {
    mockCreate.mockResolvedValue({});
    await logAudit({ action: "a" });
    expect(mockCreate).toHaveBeenCalledWith({ data: { actorId: null, targetId: null, action: "a", metadata: undefined, ipAddress: null } });
  });
});

describe("logAuditTx", () => {
  it("logAuditTx_givenTx_whenCalled_thenWritesThroughTxWithBeforeAfterRequestId", async () => {
    const tx: any = { accessAudit: { create: vi.fn().mockResolvedValue({}) } };
    await logAuditTx(tx, { actorId: "u1", targetId: "o1", action: "order.status_changed", requestId: "r1", entity: "order", before: { status: "a" }, after: { status: "b" } });
    expect(tx.accessAudit.create).toHaveBeenCalledWith({ data: {
      actorId: "u1", targetId: "o1", action: "order.status_changed", ipAddress: null,
      metadata: { requestId: "r1", entity: "order", before: { status: "a" }, after: { status: "b" } },
    } });
  });

  it("logAuditTx_givenWriteFails_whenCalled_thenThrowsSoTransactionRollsBack", async () => {
    const tx: any = { accessAudit: { create: vi.fn().mockRejectedValue(new Error("x")) } };
    await expect(logAuditTx(tx, { action: "a" })).rejects.toThrow("x");
  });
});
