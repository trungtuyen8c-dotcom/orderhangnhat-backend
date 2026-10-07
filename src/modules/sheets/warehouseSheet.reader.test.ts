import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.hoisted(() => { process.env.TZ = "UTC"; });
vi.mock("../../integrations/google/googleSheets.client.js", async (orig) => ({
  ...(await orig<object>()),
  listSheets: vi.fn(),
  batchGetValues: vi.fn(),
}));

import { batchGetValues, listSheets } from "../../integrations/google/googleSheets.client.js";
import { readWarehousePackRows } from "./warehouseSheet.reader.js";

const mListSheets = vi.mocked(listSheets);
const mBatchGet = vi.mocked(batchGetValues);

// Cột theo majorDimension=COLUMNS: index 0=A(BILL) 1=B(thùng) 4=E(mã) 5=F(tên) 23=X(đã xử lý).
function columns(c: { A?: string[]; B?: string[]; E?: string[]; F?: string[]; X?: string[] }): string[][] {
  const cols: string[][] = Array.from({ length: 24 }, () => []);
  cols[0] = c.A ?? []; cols[1] = c.B ?? []; cols[4] = c.E ?? []; cols[5] = c.F ?? []; cols[23] = c.X ?? [];
  return cols;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T03:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("readWarehousePackRows", () => {
  it("readWarehousePackRows_noDateTabs_returnsEmptyWithoutReadingValues", async () => {
    mListSheets.mockResolvedValue([{ title: "TRANG MẪU", sheetId: 1 }]);
    expect(await readWarehousePackRows("sid")).toEqual({ rows: [], staleBlank: [] });
    expect(mBatchGet).not.toHaveBeenCalled();
  });

  it("readWarehousePackRows_dateTab_requestsWholeTabByColumns", async () => {
    mListSheets.mockResolvedValue([{ title: "26.6", sheetId: 9 }]);
    mBatchGet.mockResolvedValue([{ values: [] }]);
    await readWarehousePackRows("sid");
    expect(mBatchGet).toHaveBeenCalledWith("sid", ["'26.6'!A1:X100000"], "COLUMNS");
  });

  it("readWarehousePackRows_validCodeRow_returnsTrimmedRowWithTabDateAndOneBasedRow", async () => {
    mListSheets.mockResolvedValue([{ title: "26.6", sheetId: 9 }]);
    mBatchGet.mockResolvedValue([{ values: columns({ A: ["BILL", " GA "], B: ["Thùng", " 3 "], E: ["Mã", " ABC12345 "], F: ["Tên", " Bag "], X: ["", "TRUE"] }) }]);
    const { rows } = await readWarehousePackRows("sid");
    expect(rows).toEqual([{
      code: "ABC12345", date: new Date("2026-06-26T00:00:00Z"), tab: "26.6", row: 2, sheetId: 9,
      bill: "GA", thung: "3", sheetName: "Bag", resolved: true,
    }]);
  });

  it.each([
    { name: "unchecked", x: "FALSE", expected: false },
    { name: "vietnamese true", x: "ĐÚNG", expected: true },
    { name: "missing", x: undefined, expected: false },
  ])("readWarehousePackRows_doneCell_$name_resolvedIs$expected", async ({ x, expected }) => {
    mListSheets.mockResolvedValue([{ title: "26.6", sheetId: 9 }]);
    mBatchGet.mockResolvedValue([{ values: columns({ E: ["ABC12345"], X: x === undefined ? [] : [x] }) }]);
    const { rows } = await readWarehousePackRows("sid");
    expect(rows[0].resolved).toBe(expected);
  });

  it("readWarehousePackRows_codeBlankButNameLeft_reportsStaleBlankRow", async () => {
    mListSheets.mockResolvedValue([{ title: "26.6", sheetId: 9 }]);
    mBatchGet.mockResolvedValue([{ values: columns({ E: ["", "ABC12345"], F: ["Old name", "Bag"] }) }]);
    const { rows, staleBlank } = await readWarehousePackRows("sid");
    expect(staleBlank).toEqual([{ date: new Date("2026-06-26T00:00:00Z"), tab: "26.6", row: 1, sheetId: 9 }]);
    expect(rows.map((r) => r.row)).toEqual([2]);
  });

  it("readWarehousePackRows_invalidCodeAndNoName_ignoresRow", async () => {
    mListSheets.mockResolvedValue([{ title: "26.6", sheetId: 9 }]);
    mBatchGet.mockResolvedValue([{ values: columns({ E: ["Mã tracking", "0", "AB 12345 6"], F: ["", "", ""] }) }]);
    expect(await readWarehousePackRows("sid")).toEqual({ rows: [], staleBlank: [] });
  });

  it("readWarehousePackRows_recentDays_skipsTabsOlderThanCutoff", async () => {
    mListSheets.mockResolvedValue([{ title: "20.6", sheetId: 1 }, { title: "29.6", sheetId: 2 }]);
    mBatchGet.mockResolvedValue([{ values: [] }]);
    await readWarehousePackRows("sid", 3);
    expect(mBatchGet).toHaveBeenCalledWith("sid", ["'29.6'!A1:X100000"], "COLUMNS");
  });

  it("readWarehousePackRows_recentDaysExcludesAllTabs_returnsEmptyWithoutReadingValues", async () => {
    mListSheets.mockResolvedValue([{ title: "20.6", sheetId: 1 }]);
    expect(await readWarehousePackRows("sid", 3)).toEqual({ rows: [], staleBlank: [] });
    expect(mBatchGet).not.toHaveBeenCalled();
  });

  it("readWarehousePackRows_51DateTabs_readsInTwoBatchesOf50And1", async () => {
    const tabs = Array.from({ length: 51 }, (_, i) => ({ title: `${(i % 28) + 1}.${Math.floor(i / 28) + 1}`, sheetId: i }));
    mListSheets.mockResolvedValue(tabs);
    mBatchGet.mockImplementation(async (_sid, ranges) => ranges.map(() => ({ values: [] })));
    await readWarehousePackRows("sid");
    expect(mBatchGet.mock.calls.map((c) => c[1].length)).toEqual([50, 1]);
  });

  it("readWarehousePackRows_secondBatch_mapsRowsToTheirOwnTab", async () => {
    const tabs = Array.from({ length: 51 }, (_, i) => ({ title: `${(i % 28) + 1}.${Math.floor(i / 28) + 1}`, sheetId: 100 + i }));
    mListSheets.mockResolvedValue(tabs);
    mBatchGet.mockImplementation(async (_sid, ranges) => ranges.length === 1 ? [{ values: columns({ E: ["ABC12345"] }) }] : ranges.map(() => ({ values: [] })));
    const { rows } = await readWarehousePackRows("sid");
    expect(rows.map((r) => ({ tab: r.tab, sheetId: r.sheetId }))).toEqual([{ tab: "23.2", sheetId: 150 }]);
  });
});
