import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { backupRun: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() } },
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../jobs/queues.js", () => ({ enqueue: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
vi.mock("./backup.runner.js", () => ({
  rcloneConnected: vi.fn(),
  setRcloneToken: vi.fn(),
  disconnectRclone: vi.fn(),
}));

import { startManualBackup, connectDrive, getStatus, startScheduledBackup, failStuckRuns, STUCK_RUN_MAX_AGE_MS } from "./backup.service.js";
import { logWarn } from "../../infrastructure/systemLog.js";
import { prisma } from "../../infrastructure/prisma.js";
import { enqueue } from "../../jobs/queues.js";
import { logAudit } from "../../app/audit.js";
import { rcloneConnected, setRcloneToken } from "./backup.runner.js";

const mp = prisma as any;
const actor = { id: "admin-1" };

describe("startManualBackup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("startManualBackup_runAlreadyActive_throws409BusyWithoutCreatingOrEnqueuing", async () => {
    mp.backupRun.count.mockResolvedValue(1);
    const err = await startManualBackup(actor).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.toBody()).toEqual({ error: "BUSY", message: "Đang có bản backup chạy" });
    expect(mp.backupRun.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("startManualBackup_idle_createsPendingRunEnqueuesJobAndSerializesBigInt", async () => {
    mp.backupRun.count.mockResolvedValue(0);
    mp.backupRun.create.mockImplementation(({ data }: any) => Promise.resolve({ ...data, sizeBytes: 0n }));
    const run = await startManualBackup(actor);
    expect(run.status).toBe("pending");
    expect(run.sizeBytes).toBe(0);
    expect(enqueue).toHaveBeenCalledWith("backup.create", { runId: run.id }, { attempts: 1 });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "backup.run", targetId: run.id }));
  });
});

describe("connectDrive", () => {
  beforeEach(() => vi.clearAllMocks());

  it("connectDrive_rcloneRejectsToken_throws400BadTokenAndSkipsAudit", async () => {
    (setRcloneToken as any).mockRejectedValue(new SyntaxError("bad json"));
    const err = await connectDrive("not-json-token", actor).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.toBody()).toEqual({ error: "BAD_TOKEN", message: "Token không hợp lệ" });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("connectDrive_validToken_returnsConnectedState", async () => {
    (setRcloneToken as any).mockResolvedValue(undefined);
    (rcloneConnected as any).mockResolvedValue(true);
    expect(await connectDrive('{"access_token":"x"}', actor)).toEqual({ connected: true });
  });
});

describe("getStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getStatus_noRuns_returnsNullLastAndNotRunning", async () => {
    (rcloneConnected as any).mockResolvedValue(false);
    mp.backupRun.findFirst.mockResolvedValue(null);
    mp.backupRun.count.mockResolvedValue(0);
    expect(await getStatus()).toEqual({ connected: false, running: false, last: null });
  });
});

describe("startScheduledBackup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("startScheduledBackup_idleAndConnected_createsScheduledRunWithoutActorAndEnqueues", async () => {
    // Given
    (rcloneConnected as any).mockResolvedValue(true);
    mp.backupRun.count.mockResolvedValue(0);
    mp.backupRun.create.mockImplementation(({ data }: any) => Promise.resolve({ ...data, sizeBytes: 0n }));
    // When
    const r = await startScheduledBackup();
    // Then
    expect(r.started).toBe(true);
    expect(mp.backupRun.create.mock.calls[0][0].data).toMatchObject({ kind: "scheduled", status: "pending", triggeredBy: null });
    expect(enqueue).toHaveBeenCalledWith("backup.create", { runId: r.runId }, { attempts: 1 });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("startScheduledBackup_runActive_skipsAsBusy", async () => {
    (rcloneConnected as any).mockResolvedValue(true);
    mp.backupRun.count.mockResolvedValue(1);
    expect(await startScheduledBackup()).toEqual({ started: false, reason: "BUSY" });
    expect(mp.backupRun.create).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("startScheduledBackup_driveNotConnected_skipsWithoutCreatingRun", async () => {
    (rcloneConnected as any).mockResolvedValue(false);
    expect(await startScheduledBackup()).toEqual({ started: false, reason: "NOT_CONNECTED" });
    expect(mp.backupRun.count).not.toHaveBeenCalled();
    expect(mp.backupRun.create).not.toHaveBeenCalled();
  });
});

describe("failStuckRuns", () => {
  beforeEach(() => vi.clearAllMocks());

  it("failStuckRuns_oldPendingOrRunning_marksFailedAndLogs", async () => {
    // Given
    const now = new Date("2026-10-06T12:00:00Z");
    mp.backupRun.updateMany.mockResolvedValue({ count: 2 });
    // When
    const n = await failStuckRuns(STUCK_RUN_MAX_AGE_MS, now);
    // Then
    expect(n).toBe(2);
    const args = mp.backupRun.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ status: { in: ["pending", "running"] }, startedAt: { lt: new Date("2026-10-06T06:00:00Z") } });
    expect(args.data).toMatchObject({ status: "failed", finishedAt: now });
    expect(typeof args.data.error).toBe("string");
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ count: 2 }), "backup_stuck_runs_failed");
  });

  it("failStuckRuns_noneStuck_returnsZeroWithoutLogging", async () => {
    mp.backupRun.updateMany.mockResolvedValue({ count: 0 });
    expect(await failStuckRuns()).toBe(0);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
