import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../db.js", () => ({
  prisma: { tracking: { create: vi.fn(), findFirst: vi.fn() } },
}));

import { createOrphanTrackingSafe } from "./gsheets.js";
import { prisma } from "../db.js";

const mockPrisma = prisma as unknown as {
  tracking: { create: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.0.0" });
}

describe("createOrphanTrackingSafe", () => {
  beforeEach(() => vi.clearAllMocks());

  it("createOrphanTrackingSafe_createSucceeds_returnsCreatedRow", async () => {
    const created = { id: "t1", code: "ABC12345", orderId: null };
    mockPrisma.tracking.create.mockResolvedValue(created);
    const result = await createOrphanTrackingSafe({ id: "t1", code: "ABC12345" } as any);
    expect(result).toBe(created);
    expect(mockPrisma.tracking.findFirst).not.toHaveBeenCalled();
  });

  it("createOrphanTrackingSafe_uniqueConstraintCollisionRowExists_returnsExistingRowInstead", async () => {
    mockPrisma.tracking.create.mockRejectedValue(p2002());
    const existing = { id: "existing1", code: "ABC12345", orderId: null };
    mockPrisma.tracking.findFirst.mockResolvedValue(existing);
    const result = await createOrphanTrackingSafe({ id: "t1", code: "ABC12345" } as any);
    expect(result).toBe(existing);
    expect(mockPrisma.tracking.findFirst).toHaveBeenCalledWith({ where: { code: "ABC12345", orderId: null } });
  });

  it("createOrphanTrackingSafe_uniqueConstraintCollisionButNoExistingRowFound_rethrowsOriginalError", async () => {
    const err = p2002();
    mockPrisma.tracking.create.mockRejectedValue(err);
    mockPrisma.tracking.findFirst.mockResolvedValue(null);
    await expect(createOrphanTrackingSafe({ id: "t1", code: "ABC12345" } as any)).rejects.toBe(err);
  });

  it("createOrphanTrackingSafe_otherPrismaErrorCode_rethrowsWithoutLookingUpExisting", async () => {
    const err = new Prisma.PrismaClientKnownRequestError("Foreign key failed", { code: "P2003", clientVersion: "5.0.0" });
    mockPrisma.tracking.create.mockRejectedValue(err);
    await expect(createOrphanTrackingSafe({ id: "t1", code: "ABC12345" } as any)).rejects.toBe(err);
    expect(mockPrisma.tracking.findFirst).not.toHaveBeenCalled();
  });

  it("createOrphanTrackingSafe_nonPrismaError_rethrowsAsIs", async () => {
    const err = new Error("network down");
    mockPrisma.tracking.create.mockRejectedValue(err);
    await expect(createOrphanTrackingSafe({ id: "t1", code: "ABC12345" } as any)).rejects.toBe(err);
  });
});
