import { describe, it, expect } from "vitest";
import { dayDiff, proposeMatches, shiftDate } from "./statementImport.match.js";

describe("proposeMatches", () => {
  it("sameSignedAmountWithinTolerance_matches", () => {
    const out = proposeMatches([{ rowIndex: 1, date: "2026-10-07", amount: -100000 }], [{ id: "t1", amount: -100000, date: "2026-10-05" }], 2);
    expect(out).toEqual([{ rowIndex: 1, txnId: "t1", dayDiff: 2 }]);
  });
  it("oppositeSign_or_outsideTolerance_noMatch", () => {
    expect(proposeMatches([{ rowIndex: 1, date: "2026-10-07", amount: 100000 }], [{ id: "t1", amount: -100000, date: "2026-10-07" }], 2)).toEqual([]);
    expect(proposeMatches([{ rowIndex: 1, date: "2026-10-07", amount: 5 }], [{ id: "t1", amount: 5, date: "2026-10-04" }], 2)).toEqual([]);
  });
  it("oneToOne_greedyByClosestDate", () => {
    const rows = [{ rowIndex: 1, date: "2026-10-05", amount: 50 }, { rowIndex: 2, date: "2026-10-07", amount: 50 }];
    const txns = [{ id: "a", amount: 50, date: "2026-10-06" }, { id: "b", amount: 50, date: "2026-10-07" }];
    // row2-b (0 ngày) trước, rồi row1-a (1 ngày) - không để row1 lấy mất b.
    expect(proposeMatches(rows, txns, 2)).toEqual([{ rowIndex: 1, txnId: "a", dayDiff: 1 }, { rowIndex: 2, txnId: "b", dayDiff: 0 }]);
  });
  it("moreRowsThanTxns_extraRowsUnmatched", () => {
    const rows = [{ rowIndex: 1, date: "2026-10-07", amount: 10 }, { rowIndex: 2, date: "2026-10-07", amount: 10 }];
    expect(proposeMatches(rows, [{ id: "a", amount: 10, date: "2026-10-07" }], 2)).toEqual([{ rowIndex: 1, txnId: "a", dayDiff: 0 }]);
  });
  it("rowsWithParseErrors_ignored_and_centsCompared", () => {
    const rows = [{ rowIndex: 1, date: null, amount: 10 }, { rowIndex: 2, date: "2026-10-07", amount: 0.1 + 0.2 }];
    expect(proposeMatches(rows, [{ id: "a", amount: 0.3, date: "2026-10-07" }], 0)).toEqual([{ rowIndex: 2, txnId: "a", dayDiff: 0 }]);
  });
});

describe("date helpers", () => {
  it("dayDiffAcrossMonth_and_shift", () => {
    expect(dayDiff("2026-09-30", "2026-10-02")).toBe(2);
    expect(shiftDate("2026-10-01", -2)).toBe("2026-09-29");
  });
});
