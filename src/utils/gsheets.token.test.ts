import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// getToken() cache/refresh và apiSheet() retry logic không được export trực tiếp -> test gián tiếp qua
// readWarehousePackRows/syncTracking (đường đi thật của cả 2 hàm nội bộ này). Mock fetch + jsonwebtoken,
// KHÔNG gọi API Google thật. Mỗi test tự set env + vi.resetModules() vì SA_EMAIL/SA_KEY/GSHEET_ID được
// đọc 1 lần ở module scope lúc import.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
  process.env.GOOGLE_SA_EMAIL = "sa@test.iam.gserviceaccount.com";
  process.env.GOOGLE_SA_PRIVATE_KEY = "fake-test-key";
  process.env.GSHEET_ID = "test-sheet-id-1234567890";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...ORIGINAL_ENV };
});

async function loadGsheets() {
  vi.doMock("../db.js", () => ({ prisma: {} }));
  vi.doMock("./orderTotals.js", () => ({ recomputeOrderTotals: vi.fn(), trackingShipVnd: vi.fn() }));
  vi.doMock("./cartons.js", () => ({ deleteCartonIfEmpty: vi.fn() }));
  vi.doMock("./systemLog.js", () => ({ logWarn: vi.fn(), logError: vi.fn() }));
  vi.doMock("jsonwebtoken", () => ({ default: { sign: vi.fn(() => "signed.jwt.token") } }));
  return import("./gsheets.js");
}

function oauthResponse() {
  return { ok: true, status: 200, json: async () => ({ access_token: `tok-${Math.random()}`, expires_in: 3600 }) };
}

describe("getToken caching (via readWarehousePackRows)", () => {
  it("getToken_secondCallWithinCacheWindow_reusesCachedTokenWithoutRefetching", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return oauthResponse();
      return { ok: true, status: 200, json: async () => ({ sheets: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    await readWarehousePackRows("sid1");
    await readWarehousePackRows("sid1");

    const oauthCalls = fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith("https://oauth2.googleapis.com/token"));
    expect(oauthCalls.length).toBe(1);
  });

  it("getToken_cacheExpired_fetchesNewTokenOnNextCall", async () => {
    let oauthCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        oauthCallCount++;
        return { ok: true, status: 200, json: async () => ({ access_token: `tok-${oauthCallCount}`, expires_in: 120 }) };
      }
      return { ok: true, status: 200, json: async () => ({ sheets: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    await readWarehousePackRows("sid1");
    expect(oauthCallCount).toBe(1);

    // expires_in=120s, cache dùng được khi exp > now+60s -> đẩy đồng hồ qua mốc đó (61s) để hết hạn cache
    vi.setSystemTime(new Date(Date.now() + 61000));

    await readWarehousePackRows("sid1");
    expect(oauthCallCount).toBe(2);
  });
});

describe("apiSheet retry logic (via readWarehousePackRows)", () => {
  it("apiSheet_retryableStatus429_retriesAndEventuallySucceeds", async () => {
    vi.useFakeTimers();
    let sheetsCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return oauthResponse();
      sheetsCallCount++;
      if (sheetsCallCount === 1) return { ok: false, status: 429, text: async () => "rate limited" };
      return { ok: true, status: 200, json: async () => ({ sheets: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    const promise = readWarehousePackRows("sid1");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual({ rows: [], staleBlank: [] });
    expect(sheetsCallCount).toBe(2);
  });

  it("apiSheet_retryableStatus5xx_retriesAndEventuallySucceeds", async () => {
    vi.useFakeTimers();
    let sheetsCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return oauthResponse();
      sheetsCallCount++;
      if (sheetsCallCount <= 2) return { ok: false, status: 503, text: async () => "unavailable" };
      return { ok: true, status: 200, json: async () => ({ sheets: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    const promise = readWarehousePackRows("sid1");
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;

    expect(result).toEqual({ rows: [], staleBlank: [] });
    expect(sheetsCallCount).toBe(3);
  });

  it("apiSheet_nonRetryableStatus400_throwsImmediatelyWithoutRetrying", async () => {
    let sheetsCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return oauthResponse();
      sheetsCallCount++;
      return { ok: false, status: 400, text: async () => "bad request" };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    await expect(readWarehousePackRows("sid1")).rejects.toThrow(/GSHEET_API/);
    expect(sheetsCallCount).toBe(1);
  });

  it("apiSheet_retriesExhaustedAfter5Attempts_throwsWithLastStatus", async () => {
    vi.useFakeTimers();
    let sheetsCallCount = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) return oauthResponse();
      sheetsCallCount++;
      return { ok: false, status: 500, text: async () => "server error" };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { readWarehousePackRows } = await loadGsheets();

    const promise = readWarehousePackRows("sid1");
    const assertion = expect(promise).rejects.toThrow(/GSHEET_API.*500/);
    await vi.advanceTimersByTimeAsync(30000);
    await assertion;
    expect(sheetsCallCount).toBe(5);
  });
});

describe("gsheetsEnabled / saEnabled env-var gating", () => {
  it("syncTracking_gsheetIdMissing_returnsWithoutCallingFetch", async () => {
    delete process.env.GSHEET_ID;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { syncTracking } = await loadGsheets();

    await syncTracking({ id: "t1", code: "ABC12345" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncTracking_serviceAccountEmailMissing_returnsWithoutCallingFetch", async () => {
    delete process.env.GOOGLE_SA_EMAIL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { syncTracking } = await loadGsheets();

    await syncTracking({ id: "t1", code: "ABC12345" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("readInvoiceTaxRows_serviceAccountCredsMissing_returnsEmptyArrayWithoutFetching", async () => {
    delete process.env.GOOGLE_SA_PRIVATE_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { readInvoiceTaxRows } = await loadGsheets();

    const result = await readInvoiceTaxRows("some-sheet-id");
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncPackedFromWarehouse_serviceAccountCredsMissing_returnsZeroWithoutTouchingDb", async () => {
    delete process.env.GOOGLE_SA_EMAIL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { syncPackedFromWarehouse } = await loadGsheets();

    const result = await syncPackedFromWarehouse();
    expect(result).toEqual({ matched: 0, updated: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clearWarehouseRow_serviceAccountCredsMissing_doesNothing", async () => {
    delete process.env.GOOGLE_SA_PRIVATE_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { clearWarehouseRow } = await loadGsheets();

    await clearWarehouseRow(new Date(), 5);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
