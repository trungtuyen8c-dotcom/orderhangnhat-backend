import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    tracking: { count: vi.fn() },
    carton: { delete: vi.fn() },
  },
}));

import { deleteCartonIfEmpty } from "./cartons.js";
import { prisma } from "../db.js";

const mockPrisma = prisma as unknown as {
  tracking: { count: ReturnType<typeof vi.fn> };
  carton: { delete: ReturnType<typeof vi.fn> };
};

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
