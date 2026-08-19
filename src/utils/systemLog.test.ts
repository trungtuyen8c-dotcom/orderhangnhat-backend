import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { systemLog: { create: vi.fn() } },
}));
vi.mock("../logger.js", () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

import { logWarn, logError } from "./systemLog.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";

const mockCreate = (prisma as unknown as { systemLog: { create: ReturnType<typeof vi.fn> } }).systemLog.create;
const mockLoggerWarn = logger.warn as ReturnType<typeof vi.fn>;
const mockLoggerError = logger.error as ReturnType<typeof vi.fn>;

describe("logWarn", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logWarn_callsLoggerWarn_withMetaAndMessage", () => {
    mockCreate.mockResolvedValue(undefined);
    logWarn({ code: "A1" }, "late_orders_no_tracking");
    expect(mockLoggerWarn).toHaveBeenCalledWith({ code: "A1" }, "late_orders_no_tracking");
  });

  it("logWarn_persistsToDb_withLevelWarn", () => {
    mockCreate.mockResolvedValue(undefined);
    logWarn({ code: "A1" }, "late_orders_no_tracking");
    expect(mockCreate).toHaveBeenCalledWith({ data: { level: "warn", message: "late_orders_no_tracking", meta: { code: "A1" } } });
  });

  it("logWarn_dbCreateRejects_doesNotThrowOrRejectUnhandled", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));
    expect(() => logWarn({ code: "A1" }, "late_orders_no_tracking")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});

describe("logError", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logError_callsLoggerError_withMetaAndMessage", () => {
    mockCreate.mockResolvedValue(undefined);
    logError({ err: "boom" }, "gsheets_sync_tracking_failed");
    expect(mockLoggerError).toHaveBeenCalledWith({ err: "boom" }, "gsheets_sync_tracking_failed");
  });

  it("logError_persistsToDb_withLevelError", () => {
    mockCreate.mockResolvedValue(undefined);
    logError({ err: "boom" }, "gsheets_sync_tracking_failed");
    expect(mockCreate).toHaveBeenCalledWith({ data: { level: "error", message: "gsheets_sync_tracking_failed", meta: { err: "boom" } } });
  });

  it("logError_dbCreateRejects_doesNotThrowOrRejectUnhandled", async () => {
    mockCreate.mockRejectedValue(new Error("db down"));
    expect(() => logError({ err: "boom" }, "gsheets_sync_tracking_failed")).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
