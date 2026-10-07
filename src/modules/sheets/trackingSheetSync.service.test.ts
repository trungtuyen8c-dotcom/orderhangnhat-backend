import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// SHEET_ID/TAB và cờ tabReady nằm ở module scope -> mỗi test resetModules + import lại với env riêng.
const ORIGINAL_ENV = { ...process.env };

const client = {
  appendValues: vi.fn(async () => ({})),
  clearValues: vi.fn(async () => ({})),
  ensureSheetTab: vi.fn(async () => {}),
  getValues: vi.fn(async (_sid: string, _tab: string, _a1: string): Promise<string[][]> => []),
  updateValues: vi.fn(async () => ({})),
};
const auth = { serviceAccountEnabled: vi.fn(() => true) };
const log = { logError: vi.fn(), logWarn: vi.fn() };

async function load(env: { GSHEET_ID?: string; GSHEET_TAB?: string } = { GSHEET_ID: "sheet-1" }) {
  vi.resetModules();
  delete process.env.GSHEET_ID;
  delete process.env.GSHEET_TAB;
  Object.assign(process.env, env);
  vi.doMock("../../integrations/google/googleSheets.client.js", () => client);
  vi.doMock("../../integrations/google/googleAuth.js", () => auth);
  vi.doMock("../../infrastructure/systemLog.js", () => log);
  return import("./trackingSheetSync.service.js");
}

// Sheet giả: cột A theo thứ tự dòng (dòng 1 = header "ID").
function sheetColumnA(ids: string[]) {
  client.getValues.mockImplementation(async (_sid: string, _tab: string, a1: string) =>
    a1 === "A1:A1" ? (ids.length ? [[ids[0]]] : []) : ids.map((id) => [id]),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  auth.serviceAccountEnabled.mockReturnValue(true);
  client.getValues.mockImplementation(async (): Promise<string[][]> => []);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T01:02:03.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

describe("gsheetsEnabled", () => {
  it.each([
    ["sa on + sheet id", true, "sheet-1", true],
    ["sa off", false, "sheet-1", false],
    ["no sheet id", true, undefined, false],
  ])("gsheetsEnabled_%s_returns_%s", async (_n, sa, sheetId, expected) => {
    auth.serviceAccountEnabled.mockReturnValue(sa as boolean);
    const { gsheetsEnabled } = await load({ GSHEET_ID: sheetId as string | undefined });

    expect(gsheetsEnabled()).toBe(expected);
  });
});

describe("syncTracking", () => {
  it("syncTracking_disabled_makesNoSheetCalls", async () => {
    auth.serviceAccountEnabled.mockReturnValue(false);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });

    expect(client.getValues).not.toHaveBeenCalled();
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it("syncTracking_newTracking_appendsFullRowToDefaultTrackingTab", async () => {
    sheetColumnA(["ID", "t0"]);
    const { syncTracking } = await load();

    await syncTracking({
      id: "t1", code: "TRK00001", jpName: "シャツ", jpWeightKg: "1.5", unitPriceVndPerKg: "200000",
      vnTrackingCode: "VN1", orderId: "o1", status: "packed",
    });

    expect(client.appendValues).toHaveBeenCalledWith("sheet-1", "Tracking", "A1", [[
      "t1", "TRK00001", "シャツ", 1.5, 200000, 300000, "VN1", "o1", "packed", "2026-10-07T01:02:03.000Z",
    ]]);
    expect(client.updateValues).not.toHaveBeenCalled();
  });

  it("syncTracking_existingTrackingOnRow3_updatesThatRowInPlace", async () => {
    sheetColumnA(["ID", "t0", "t1"]);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });

    expect(client.updateValues).toHaveBeenCalledWith("sheet-1", "Tracking", "A3", expect.objectContaining({ values: [expect.any(Array)] }));
    expect(client.appendValues).not.toHaveBeenCalled();
  });

  it("syncTracking_missingWeightAndPrice_writesBlankKgPriceAndAmount", async () => {
    sheetColumnA(["ID"]);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });

    const row = (client.appendValues.mock.calls[0] as unknown[])[3] as unknown[][];
    expect(row[0].slice(2, 9)).toEqual(["", "", "", "", "", "", ""]);
  });

  it("syncTracking_emptySheet_writesHeaderRowAtA1", async () => {
    sheetColumnA([]);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });

    const headerCall = client.updateValues.mock.calls.find((c) => (c as unknown[])[2] === "A1") as unknown[] | undefined;
    expect((headerCall?.[3] as { values: string[][] }).values[0]).toEqual([
      "ID", "Mã tracking", "Tên (JP)", "Cân (kg)", "Đơn giá đ/kg", "Thành tiền VND", "Tracking VN", "Đơn (orderId)", "Trạng thái", "Cập nhật",
    ]);
  });

  it("syncTracking_headerAlreadyPresent_doesNotRewriteHeader", async () => {
    sheetColumnA(["ID"]);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });

    expect(client.updateValues).not.toHaveBeenCalled();
  });

  it("syncTracking_calledTwice_ensuresTabOnlyOnce", async () => {
    sheetColumnA(["ID"]);
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });
    await syncTracking({ id: "t2", code: "TRK00002" });

    expect(client.ensureSheetTab).toHaveBeenCalledTimes(1);
    expect(client.ensureSheetTab).toHaveBeenCalledWith("sheet-1", "Tracking");
  });

  it("syncTracking_customTabEnv_writesToThatTab", async () => {
    sheetColumnA(["ID"]);
    const { syncTracking } = await load({ GSHEET_ID: "sheet-1", GSHEET_TAB: "TRK 2026" });

    await syncTracking({ id: "t1", code: "TRK00001" });

    expect(client.appendValues).toHaveBeenCalledWith("sheet-1", "TRK 2026", "A1", expect.any(Array));
  });

  it("syncTracking_sheetApiThrows_logsErrorAndResolves", async () => {
    client.getValues.mockRejectedValue(new Error("GSHEET_API 500"));
    const { syncTracking } = await load();

    await expect(syncTracking({ id: "t1", code: "TRK00001" })).resolves.toBeUndefined();

    expect(log.logError).toHaveBeenCalledWith({ err: "GSHEET_API 500" }, "gsheets_sync_tracking_failed");
  });

  it("syncTracking_ensureTabFails_retriesEnsureOnNextCall", async () => {
    sheetColumnA(["ID"]);
    client.ensureSheetTab.mockRejectedValueOnce(new Error("boom"));
    const { syncTracking } = await load();

    await syncTracking({ id: "t1", code: "TRK00001" });
    await syncTracking({ id: "t1", code: "TRK00001" });

    expect(client.ensureSheetTab).toHaveBeenCalledTimes(2);
    expect(client.appendValues).toHaveBeenCalledTimes(1);
  });
});

describe("removeTrackingRow", () => {
  it("removeTrackingRow_disabled_makesNoSheetCalls", async () => {
    auth.serviceAccountEnabled.mockReturnValue(false);
    const { removeTrackingRow } = await load();

    await removeTrackingRow("t1");

    expect(client.getValues).not.toHaveBeenCalled();
  });

  it("removeTrackingRow_existingRow4_clearsColumnsAtoJOfThatRow", async () => {
    sheetColumnA(["ID", "t0", "tX", "t1"]);
    const { removeTrackingRow } = await load();

    await removeTrackingRow("t1");

    expect(client.clearValues).toHaveBeenCalledWith("sheet-1", "Tracking", "A4:J4");
  });

  it("removeTrackingRow_idNotInSheet_clearsNothing", async () => {
    sheetColumnA(["ID", "t0"]);
    const { removeTrackingRow } = await load();

    await removeTrackingRow("t1");

    expect(client.clearValues).not.toHaveBeenCalled();
  });

  it("removeTrackingRow_sheetApiThrows_logsErrorAndResolves", async () => {
    client.getValues.mockRejectedValue(new Error("GSHEET_API 403"));
    const { removeTrackingRow } = await load();

    await expect(removeTrackingRow("t1")).resolves.toBeUndefined();

    expect(log.logError).toHaveBeenCalledWith({ err: "GSHEET_API 403" }, "gsheets_remove_tracking_row_failed");
  });
});
