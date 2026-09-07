import { describe, it, expect } from "vitest";
import { mk } from "./companycost.routes.js";

describe("mk", () => {
  it("mk_dateWellWithinVnMonth_returnsThatMonth", () => {
    expect(mk(new Date("2026-03-15T12:00:00Z"))).toBe("2026-03");
  });

  // Regression: server chạy giờ UTC, kho quét mã lúc 03:00 sáng giờ VN ngày 1/3 = 20:00 UTC ngày 28/2.
  // Bản cũ đọc getFullYear/getMonth trực tiếp (= giờ UTC) -> trả về tháng 2, sai tháng báo cáo phải trả kho/cty.
  it("mk_utcInstantInEarlyMorningVnWindow_returnsCorrectVnMonthNotUtcMonth", () => {
    expect(mk(new Date("2026-02-28T20:00:00Z"))).toBe("2026-03");
  });

  it("mk_lastSecondOfVnMonthNearUtcBoundary_staysInThatMonth", () => {
    expect(mk(new Date("2026-03-31T16:59:59Z"))).toBe("2026-03");
  });
});
