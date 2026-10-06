import { describe, it, expect, vi, beforeEach } from "vitest";

const cfg = vi.hoisted(() => ({ workersEnabled: true, backupCron: "0 2 * * *" }));
vi.mock("../app/config.js", () => ({ config: cfg }));
vi.mock("node-cron", () => ({ default: { schedule: vi.fn(), validate: vi.fn((e: string) => e.split(" ").length >= 5) } }));
vi.mock("./alerts.js", () => ({ startJobs: vi.fn() }));
vi.mock("./queues.js", () => ({ startWorkers: vi.fn() }));
vi.mock("../modules/backup/backup.service.js", () => ({ failStuckRuns: vi.fn(), startScheduledBackup: vi.fn() }));
vi.mock("../infrastructure/systemLog.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import cron from "node-cron";
import { startBackground, scheduleBackupCron, BACKUP_TIMEZONE } from "./runtime.js";
import { startJobs } from "./alerts.js";
import { startWorkers } from "./queues.js";
import { failStuckRuns, startScheduledBackup } from "../modules/backup/backup.service.js";
import { logError } from "../infrastructure/systemLog.js";

const schedule = cron.schedule as unknown as ReturnType<typeof vi.fn>;

describe("startBackground", () => {
  beforeEach(() => { vi.clearAllMocks(); cfg.workersEnabled = true; cfg.backupCron = "0 2 * * *"; });

  it("api_workersDisabled_startsNoWorkerNoCronNoCleanup", async () => {
    cfg.workersEnabled = false;
    expect(await startBackground({ role: "api" })).toBe(false);
    expect(startWorkers).not.toHaveBeenCalled();
    expect(startJobs).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
    expect(failStuckRuns).not.toHaveBeenCalled();
  });

  it("api_workersEnabled_cleansStuckRunsThenStartsWorkersAlertsAndBackupCron", async () => {
    expect(await startBackground({ role: "api" })).toBe(true);
    expect(failStuckRuns).toHaveBeenCalledTimes(1);
    expect(startWorkers).toHaveBeenCalledWith({ force: true });
    expect(startJobs).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledWith("0 2 * * *", expect.any(Function), { timezone: BACKUP_TIMEZONE });
  });

  it("worker_forceIgnoresWorkersEnabledFalse", async () => {
    cfg.workersEnabled = false;
    expect(await startBackground({ force: true, role: "worker" })).toBe(true);
    expect(startWorkers).toHaveBeenCalled();
    expect(startJobs).toHaveBeenCalled();
  });

  it("stuckCleanupFails_stillStartsWorkers", async () => {
    (failStuckRuns as any).mockRejectedValueOnce(new Error("db down"));
    expect(await startBackground({ role: "worker", force: true })).toBe(true);
    expect(logError).toHaveBeenCalledWith({ err: "db down" }, "backup_stuck_cleanup_failed");
    expect(startWorkers).toHaveBeenCalled();
  });
});

describe("scheduleBackupCron", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emptyExpr_disablesBackupCron", () => {
    expect(scheduleBackupCron("  ")).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("invalidExpr_logsErrorAndSkips", () => {
    expect(scheduleBackupCron("bad")).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith({ expr: "bad" }, "backup_cron_invalid");
  });

  it("validExpr_tickCallsStartScheduledBackup", async () => {
    (startScheduledBackup as any).mockResolvedValue({ started: true });
    expect(scheduleBackupCron("30 3 * * *")).toBe(true);
    const tick = schedule.mock.calls[0][1];
    tick();
    expect(startScheduledBackup).toHaveBeenCalledTimes(1);
  });
});
