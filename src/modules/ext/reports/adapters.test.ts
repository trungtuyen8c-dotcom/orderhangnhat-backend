import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../shipments/shipments.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shipments/shipments.service.js")>();
  return {
    parseMonth: actual.parseMonth,
    taxAudit: vi.fn(async () => "audit"),
    invoiceChecklist: vi.fn(async () => "checklist"),
    listTaxRows: vi.fn(async () => "rows"),
    listDocumentsPublic: vi.fn(async () => "docs"),
  };
});
vi.mock("../../companycost/companycost.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../companycost/companycost.service.js")>();
  return { monthOrCurrent: actual.monthOrCurrent, report: vi.fn(async (m: string) => ({ month: m })), settlement: vi.fn(), reinforceUnit: vi.fn(async () => 30000), electronicsUnit: vi.fn(async () => 5000) };
});

vi.mock("../../warehouse/warehouse.service.js", () => ({
  getVnBoard: vi.fn(), listStored: vi.fn(), searchHistory: vi.fn(), listRecon: vi.fn(),
}));

import * as shipmentsReports from "./shipments.js";
import * as whReports from "./warehouse.js";
import * as warehouse from "../../warehouse/warehouse.service.js";
import * as ccReports from "./companycost.js";
import * as shipments from "../../shipments/shipments.service.js";
import * as cc from "../../companycost/companycost.service.js";
import { AppError } from "../../../app/errors/AppError.js";

beforeEach(() => vi.clearAllMocks());

describe("ext shipments reports", () => {
  it("taxRows_alwaysReadOnly_callsServiceWithPersistFalse", async () => {
    await shipmentsReports.shipments_tax_rows();
    expect(shipments.listTaxRows).toHaveBeenCalledWith({ persist: false });
  });

  it("taxAudit_invalidMonth_throwsLegacyBadRequestWithMessage", () => {
    let err: unknown;
    try { shipmentsReports.shipments_tax_audit({ month: "2026-3" }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).toBody()).toEqual({ error: "BAD_REQUEST", message: "month phải dạng YYYY-MM" });
    expect(shipments.taxAudit).not.toHaveBeenCalled();
  });

  it("invoiceChecklist_validMonth_passesVnMonthRange", async () => {
    await shipmentsReports.shipments_invoice_checklist({ month: "2026-03" });
    expect(shipments.invoiceChecklist).toHaveBeenCalledWith({ start: new Date("2026-03-01T00:00:00+07:00"), end: new Date("2026-04-01T00:00:00+07:00") });
  });

  it("documents_usesPublicListWithoutObjectKeys", async () => {
    await shipmentsReports.shipments_documents({ orderId: "o1" });
    expect(shipments.listDocumentsPublic).toHaveBeenCalledWith("o1");
  });
});

describe("ext companycost reports", () => {
  it("report_invalidMonth_fallsBackToCurrentVnMonth", async () => {
    const r = (await ccReports.companycost_report({ month: "bad" })) as { month: string };
    expect(r.month).toMatch(/^\d{4}-\d{2}$/);
  });

  it("report_validMonth_isPassedThrough", async () => {
    await ccReports.companycost_report({ month: "2026-02" });
    expect(cc.report).toHaveBeenCalledWith("2026-02");
  });

  it("unitReports_wrapUnitInObject", async () => {
    expect(await ccReports.companycost_reinforce_price()).toEqual({ unit: 30000 });
    expect(await ccReports.companycost_electronics_price()).toEqual({ unit: 5000 });
  });
});

describe("ext warehouse reports", () => {
  it("vnBoard_blankCustomer_passesUndefined", async () => {
    await whReports.warehouse_vn_board({ customer: "   " });
    expect(warehouse.getVnBoard).toHaveBeenCalledWith(undefined);
  });

  it("history_trimsEveryFilter", async () => {
    await whReports.warehouse_history({ date: " 2026-03-01 ", vnTrackingCode: " VN1 ", code: "" });
    expect(warehouse.searchHistory).toHaveBeenCalledWith({ date: "2026-03-01", vnTrackingCode: "VN1", code: undefined });
  });

  it("stored_trimsCustomer", async () => {
    await whReports.warehouse_stored({ customer: " An " });
    expect(warehouse.listStored).toHaveBeenCalledWith("An");
  });
});
