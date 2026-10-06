import { describe, it, expect } from "vitest";
import { EMPTY, parseOrderListQuery, toOrderBy, toOrderSql, toOrderWhere } from "./order.listFilter.js";

const parse = (q: Record<string, unknown>) => parseOrderListQuery(q).filter;

describe("parseOrderListQuery", () => {
  it("parse_emptyQuery_defaultsToNoFiltersAndOrderDateDesc", () => {
    const r = parseOrderListQuery({});
    expect(r.filter).toMatchObject({ source: "", exclude: [], status: [], excludeStatus: [] });
    expect(r.filter.q).toBeUndefined();
    expect(r.sort).toEqual({ field: "orderDate", dir: "desc" });
  });

  it("parse_commaListsAndTrimmedValues_splitIntoArrays", () => {
    const f = parse({ exclude: "yahoo, mercari", status: "draft,quoted", excludeStatus: "cancelled", q: "  JA1 " });
    expect(f.exclude).toEqual(["yahoo", "mercari"]);
    expect(f.status).toEqual(["draft", "quoted"]);
    expect(f.excludeStatus).toEqual(["cancelled"]);
    expect(f.q).toBe("JA1");
  });

  it.each([
    [{ status: "shipped" }],
    [{ excludeStatus: "nope" }],
    [{ tracking: "maybe" }],
    [{ paid: "1" }],
    [{ from: "01/02/2026" }],
    [{ month: "2026-1" }],
    [{ customerId: "abc" }],
    [{ sort: "nick" }],
    [{ order: "up" }],
  ])("parse_invalidValue_%o_throws400", (q) => {
    expect(() => parseOrderListQuery(q)).toThrowError(expect.objectContaining({ status: 400 }));
  });

  it("parse_monthLatest_isAccepted", () => {
    expect(parse({ month: "latest" }).month).toBe("latest");
  });
});

describe("toOrderWhere", () => {
  it("toOrderWhere_onlyScope_returnsScopeUnchanged", () => {
    expect(toOrderWhere(parse({ exclude: "yahoo,mercari" }))).toEqual({ source: { notIn: ["yahoo", "mercari"] } });
    expect(toOrderWhere(parse({ source: "yahoo" }))).toEqual({ source: "yahoo" });
    // source thường không phải Yahoo/Mercari -> bỏ qua như hành vi cũ
    expect(toOrderWhere(parse({ source: "normal" }))).toBeUndefined();
  });

  it("toOrderWhere_searchText_matchesCodeCustomerItemUrlAndTrackingCodeCaseInsensitive", () => {
    const w = toOrderWhere(parse({ q: "abc" }))!;
    const c = { contains: "abc", mode: "insensitive" };
    expect(w).toEqual({ AND: [{ OR: [{ code: c }, { customer: { name: c } }, { items: { some: { url: c } } }, { trackings: { some: { code: c } } }] }] });
  });

  it("toOrderWhere_allFlags_combinedWithScopeInAnd", () => {
    const w = toOrderWhere(parse({
      source: "yahoo", status: "draft", excludeStatus: "cancelled", nick: "nickA", paymentMethod: "Visa",
      tracking: "has", paid: "no", customerId: "22222222-2222-2222-2222-222222222222",
    }))!;
    expect(w.AND).toEqual([
      { source: "yahoo" },
      { status: { in: ["draft"] } },
      { status: { notIn: ["cancelled"] } },
      { nick: "nickA" },
      { items: { some: { paymentMethod: "Visa" } } },
      { trackings: { some: { code: { not: "" } } } },
      { yahooPaidAt: null },
      { customerId: "22222222-2222-2222-2222-222222222222" },
    ]);
  });

  it("toOrderWhere_emptyMarkers_matchMissingNickAndNoItemWithPaymentMethod", () => {
    const w = toOrderWhere(parse({ nick: EMPTY, paymentMethod: EMPTY, tracking: "none", paid: "yes" }))!;
    expect(w.AND).toEqual([
      { OR: [{ nick: null }, { nick: "" }] },
      { items: { none: { AND: [{ paymentMethod: { not: null } }, { paymentMethod: { not: "" } }] } } },
      { trackings: { none: { code: { not: "" } } } },
      { yahooPaidAt: { not: null } },
    ]);
  });

  it("toOrderWhere_dateRange_usesVnDayBoundsInclusive", () => {
    const w = toOrderWhere(parse({ from: "2026-07-01", to: "2026-07-31" }))!;
    expect(w.AND).toEqual([
      { orderDate: { gte: new Date("2026-06-30T17:00:00.000Z") } },
      { orderDate: { lte: new Date("2026-07-31T16:59:59.999Z") } },
    ]);
  });

  it("toOrderWhere_month_restrictsToVnCalendarMonth", () => {
    const w = toOrderWhere(parse({}), "2026-12")!;
    expect(w.AND).toEqual([{ orderDate: { gte: new Date("2026-11-30T17:00:00.000Z"), lt: new Date("2026-12-31T17:00:00.000Z") } }]);
  });
});

describe("toOrderSql", () => {
  it("toOrderSql_noFilters_isTrue", () => {
    expect(toOrderSql(parse({})).sql).toBe("TRUE");
  });

  it("toOrderSql_sameFiltersAsWhere_bindsValuesAsParameters", () => {
    const s = toOrderSql(parse({
      exclude: "yahoo,mercari", q: "ab", status: "draft", excludeStatus: "cancelled", nick: "n1",
      paymentMethod: "Visa", tracking: "has", paid: "yes", customerId: "22222222-2222-2222-2222-222222222222", from: "2026-07-01", to: "2026-07-02",
    }));
    expect(s.sql).toContain("o.source NOT IN (?,?)");
    expect(s.sql).toContain("o.code ILIKE ?");
    expect(s.sql).toContain("c.name ILIKE ?");
    expect(s.sql).toContain("i.url ILIKE ?");
    expect(s.sql).toContain("t.code ILIKE ?");
    expect(s.sql).toContain("o.status::text IN (?)");
    expect(s.sql).toContain("o.status::text NOT IN (?)");
    expect(s.sql).toContain("o.nick = ?");
    expect(s.sql).toContain("i.payment_method = ?");
    expect(s.sql).toContain("EXISTS (SELECT 1 FROM trackings t WHERE t.order_id = o.id AND t.code <> '')");
    expect(s.sql).toContain("o.yahoo_paid_at IS NOT NULL");
    expect(s.sql).toContain("o.customer_id = ?::uuid");
    expect(s.sql).toContain("o.order_date >= ?");
    expect(s.sql).toContain("o.order_date <= ?");
    expect(s.values).toEqual([
      "yahoo", "mercari", "%ab%", "%ab%", "%ab%", "%ab%", "draft", "cancelled", "n1", "Visa",
      "22222222-2222-2222-2222-222222222222", new Date("2026-06-30T17:00:00.000Z"), new Date("2026-07-02T16:59:59.999Z"),
    ]);
  });

  it("toOrderSql_emptyMarkersAndNone_useNullOrBlankChecks", () => {
    const s = toOrderSql(parse({ source: "mercari", nick: EMPTY, paymentMethod: EMPTY, tracking: "none", paid: "no" }));
    expect(s.sql).toContain("o.source = ?");
    expect(s.sql).toContain("(o.nick IS NULL OR o.nick = '')");
    expect(s.sql).toContain("NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.payment_method IS NOT NULL AND i.payment_method <> '')");
    expect(s.sql).toContain("NOT EXISTS (SELECT 1 FROM trackings t");
    expect(s.sql).toContain("o.yahoo_paid_at IS NULL");
    expect(s.values).toEqual(["mercari"]);
  });

  it("toOrderSql_monthIsIgnored_summaryCoversWholeFilteredSet", () => {
    expect(toOrderSql(parse({ month: "2026-07" })).sql).toBe("TRUE");
  });
});

describe("toOrderBy", () => {
  it("toOrderBy_eachField_mapsToPrismaOrderBy", () => {
    expect(toOrderBy({ field: "orderDate", dir: "desc" })).toEqual([{ orderDate: "desc" }, { createdAt: "desc" }]);
    expect(toOrderBy({ field: "code", dir: "asc" })).toEqual([{ code: "asc" }]);
    expect(toOrderBy({ field: "totalVnd", dir: "desc" })).toEqual([{ totalVnd: { sort: "desc", nulls: "last" } }, { orderDate: "desc" }]);
    expect(toOrderBy({ field: "createdAt", dir: "asc" })).toEqual([{ createdAt: "asc" }]);
  });
});
