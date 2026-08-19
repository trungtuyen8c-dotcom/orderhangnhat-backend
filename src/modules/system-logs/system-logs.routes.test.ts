import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sinceFromRange, buildWhere, csvEscape } from "./system-logs.routes.js";

describe("sinceFromRange", () => {
  const NOW = new Date("2026-03-15T00:00:00.000Z");
  beforeEach(() => vi.useFakeTimers().setSystemTime(NOW));
  afterEach(() => vi.useRealTimers());

  it.each([
    ["1d", 1],
    ["3d", 3],
    ["7d", 7],
    ["1m", 30],
    ["3m", 90],
  ])("sinceFromRange_validKey %s_returnsNowMinusDays", (key, days) => {
    const expected = new Date(NOW.getTime() - days * 24 * 3600 * 1000);
    expect(sinceFromRange(key)).toEqual(expected);
  });

  it("sinceFromRange_invalidOrMissingKey_defaultsTo1Day", () => {
    const expected = new Date(NOW.getTime() - 1 * 24 * 3600 * 1000);
    expect(sinceFromRange("bogus")).toEqual(expected);
    expect(sinceFromRange(undefined)).toEqual(expected);
  });
});

function fakeReq(query: Record<string, unknown>): any {
  return { query };
}

describe("buildWhere", () => {
  it("buildWhere_onlyRangeGiven_omitsLevelAndSearchConditions", () => {
    const where = buildWhere(fakeReq({ range: "7d" }));
    expect(where.sql).not.toContain("AND level");
    expect(where.sql).not.toContain("ILIKE");
    expect(where.values).toHaveLength(1);
  });

  it("buildWhere_validLevel_includesLevelCondition", () => {
    const where = buildWhere(fakeReq({ range: "1d", level: "error" }));
    expect(where.sql).toContain("AND level = ?");
    expect(where.values).toContain("error");
  });

  it("buildWhere_invalidLevel_omitsLevelCondition", () => {
    const where = buildWhere(fakeReq({ range: "1d", level: "critical" }));
    expect(where.sql).not.toContain("AND level");
    expect(where.values).not.toContain("critical");
  });

  it("buildWhere_searchQuery_includesIlikeWithWildcards", () => {
    const where = buildWhere(fakeReq({ range: "1d", q: "foo" }));
    expect(where.sql).toContain("ILIKE");
    expect(where.values).toContain("%foo%");
  });

  it("buildWhere_whitespaceOnlySearchQuery_omitsSearchCondition", () => {
    const where = buildWhere(fakeReq({ range: "1d", q: "   " }));
    expect(where.sql).not.toContain("ILIKE");
  });

  it("buildWhere_searchQueryWithSqlMetacharacters_staysParameterizedNotInlined", () => {
    const malicious = "'; DROP TABLE system_logs;--";
    const where = buildWhere(fakeReq({ range: "1d", q: malicious }));
    expect(where.sql).not.toContain("DROP TABLE");
    expect(where.values).toContain(`%${malicious}%`);
  });
});

describe("csvEscape", () => {
  it("csvEscape_plainString_wrapsInQuotes", () => {
    expect(csvEscape("hello")).toBe('"hello"');
  });

  it("csvEscape_stringContainingDoubleQuote_escapesByDoubling", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("csvEscape_%s_returnsEmptyQuotedString", (_label, value) => {
    expect(csvEscape(value)).toBe('""');
  });

  it("csvEscape_nonStringValue_jsonStringifies", () => {
    expect(csvEscape({ code: "A1" })).toBe('"{""code"":""A1""}"');
  });
});
