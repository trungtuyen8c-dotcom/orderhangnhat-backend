import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    tracking: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

import { claimOrCreateTracking } from "./trackingClaim.js";
import { prisma } from "../db.js";

const mockPrisma = prisma as unknown as {
  tracking: { findFirst: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

describe("claimOrCreateTracking", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claimOrCreateTracking_orphanExistsWithCode_updatesAndClaimsOrphan", async () => {
    mockPrisma.tracking.findFirst.mockResolvedValue({ id: "orphan-1" });
    await claimOrCreateTracking("order-1", "TRK123");
    expect(mockPrisma.tracking.update).toHaveBeenCalledWith({
      where: { id: "orphan-1" },
      data: { orderId: "order-1", status: "linked" },
    });
    expect(mockPrisma.tracking.create).not.toHaveBeenCalled();
  });

  it("claimOrCreateTracking_noOrphanFound_createsNewTracking", async () => {
    mockPrisma.tracking.findFirst.mockResolvedValue(null);
    await claimOrCreateTracking("order-1", "TRK123");
    expect(mockPrisma.tracking.create).toHaveBeenCalled();
    const data = mockPrisma.tracking.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ orderId: "order-1", code: "TRK123", status: "linked" });
  });

  it("claimOrCreateTracking_emptyCodeAfterTrim_skipsOrphanLookupAndCreatesNew", async () => {
    await claimOrCreateTracking("order-1", "   ");
    expect(mockPrisma.tracking.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.tracking.create).toHaveBeenCalled();
  });

  it("claimOrCreateTracking_codeWithWhitespace_trimsBeforeLookup", async () => {
    mockPrisma.tracking.findFirst.mockResolvedValue(null);
    await claimOrCreateTracking("order-1", "  TRK999  ");
    expect(mockPrisma.tracking.findFirst).toHaveBeenCalledWith({ where: { code: "TRK999", orderId: null } });
  });

  it("claimOrCreateTracking_extraFieldsGiven_mergesIntoClaimedOrphanUpdate", async () => {
    mockPrisma.tracking.findFirst.mockResolvedValue({ id: "orphan-1" });
    await claimOrCreateTracking("order-1", "TRK123", { packedAt: "2026-03-05" });
    expect(mockPrisma.tracking.update).toHaveBeenCalledWith({
      where: { id: "orphan-1" },
      data: { orderId: "order-1", status: "linked", packedAt: "2026-03-05" },
    });
  });

  it("claimOrCreateTracking_extraFieldsGivenNoOrphan_mergesIntoNewTracking", async () => {
    mockPrisma.tracking.findFirst.mockResolvedValue(null);
    await claimOrCreateTracking("order-1", "TRK123", { packedAt: "2026-03-05" });
    const data = mockPrisma.tracking.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ orderId: "order-1", code: "TRK123", status: "linked", packedAt: "2026-03-05" });
  });
});
