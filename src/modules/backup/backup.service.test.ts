import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: { backupRun: { count: vi.fn(), create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() } },
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../jobs/queues.js", () => ({ enqueue: vi.fn() }));
vi.mock("./backup.runner.js", () => ({
  rcloneConnected: vi.fn(),
  setRcloneToken: vi.fn(),
  disconnectRclone: vi.fn(),
}));

import { startManualBackup, connectDrive, getStatus } from "./backup.service.js";
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
