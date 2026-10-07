import { describe, it, expect, vi } from "vitest";

vi.mock("../../infrastructure/prisma.js", () => ({ prisma: {} }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logWarn: vi.fn(), logError: vi.fn() }));

import { planMonthTabs } from "./customerSheetSync.service.js";

const tabs = (noYear: [number, string][] = [], withYear: [string, string][] = []) => ({ noYear: new Map(noYear), withYear: new Map(withYear) });

describe("planMonthTabs", () => {
  it("planMonthTabs_firstYearNoTab_createsPlainMonthTab", () => {
    expect(planMonthTabs(["2026-03"], tabs())).toEqual([{ key: "2026-03", tab: "Tháng 3", create: true }]);
  });

  it("planMonthTabs_plainTabExists_usedForEarliestYear", () => {
    expect(planMonthTabs(["2026-03"], tabs([[3, "T3"]]))).toEqual([{ key: "2026-03", tab: "T3", create: false }]);
  });

  it("planMonthTabs_laterYearSameMonth_createsYearTab", () => {
    expect(planMonthTabs(["2027-03", "2026-03"], tabs([[3, "Tháng 3"]]))).toEqual([
      { key: "2026-03", tab: "Tháng 3", create: false },
      { key: "2027-03", tab: "Tháng 3/2027", create: true },
    ]);
  });

  it("planMonthTabs_yearTabExists_usedForThatYear", () => {
    expect(planMonthTabs(["2027-03"], tabs([], [["2027-03", "T3.2027"]]))).toEqual([{ key: "2027-03", tab: "T3.2027", create: false }]);
  });

  it("planMonthTabs_explicitYearTabForEarliest_plainTabGoesToNextYear", () => {
    expect(planMonthTabs(["2025-03", "2026-03"], tabs([[3, "Tháng 3"]], [["2025-03", "Tháng 3/2025"]]))).toEqual([
      { key: "2025-03", tab: "Tháng 3/2025", create: false },
      { key: "2026-03", tab: "Tháng 3", create: false },
    ]);
  });

  it("planMonthTabs_existingTabsWithoutData_returnedForCleanup", () => {
    expect(planMonthTabs([], tabs([[4, "Tháng 4"]], [["2025-05", "Tháng 5/2025"]]))).toEqual([
      { key: "----4", tab: "Tháng 4", create: false },
      { key: "2025-05", tab: "Tháng 5/2025", create: false },
    ]);
  });
});
