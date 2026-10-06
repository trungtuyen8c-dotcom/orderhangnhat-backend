import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { existsSync } from "fs";

vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "u1" }; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({ authorize: () => (_req: any, _res: any, next: any) => next() }));
vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    document: { create: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    appConfig: { findUnique: vi.fn(), upsert: vi.fn() },
    tracking: { findMany: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
    taxRowNote: { findMany: vi.fn(), findUnique: vi.fn(), createMany: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    orderItem: { findMany: vi.fn() },
  };
  p.$transaction = vi.fn(async (fn: any) => fn(p));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../integrations/minio/documentStorage.js", () => ({
  putObjectFromFile: vi.fn(),
  getObjectStream: vi.fn(),
  removeObjectQuietly: vi.fn(),
}));
vi.mock("../sheets/invoiceTaxSheet.service.js", () => ({ readInvoiceTaxRows: vi.fn(), readInvoiceTaxRowsFromExcel: vi.fn() }));

import { shipmentsRouter } from "./shipments.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { putObjectFromFile, removeObjectQuietly } from "../../integrations/minio/documentStorage.js";
import { readInvoiceTaxRowsFromExcel } from "../sheets/invoiceTaxSheet.service.js";
import { errorHandler } from "../../app/errors/errorHandler.js";

const mp = prisma as any;
const mPut = putObjectFromFile as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/shipments", shipmentsRouter);
  app.use(errorHandler);
  return app;
}

const PDF = Buffer.from("%PDF-1.4\nhello");
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

beforeEach(() => {
  vi.clearAllMocks();
  mp.document.create.mockImplementation(async ({ data }: any) => ({ ...data, createdAt: "2026-01-01T00:00:00.000Z" }));
});

describe("POST /documents", () => {
  it("upload_validPdf_streamsTempFileToMinioWithServerMimeAndDeletesTemp", async () => {
    let tmpPath = "";
    mPut.mockImplementation(async (_key: string, path: string) => { tmpPath = path; expect(existsSync(path)).toBe(true); });
    const res = await request(buildApp()).post("/api/shipments/documents")
      .field("type", "invoice").field("orderId", "o1")
      .attach("file", PDF, { filename: "../hoa don.pdf", contentType: "application/x-msdownload" });
    expect(res.status).toBe(201);
    const [key, , size, mime] = mPut.mock.calls[0];
    expect(key).toMatch(/^documents\/invoice\/[0-9a-f-]{36}-hoa don\.pdf$/);
    expect(size).toBe(PDF.length);
    expect(mime).toBe("application/pdf");
    expect(res.body).toMatchObject({ type: "invoice", orderId: "o1", objectKey: key, uploadedBy: "u1" });
    expect(existsSync(tmpPath)).toBe(false);
  });

  it("upload_missingType_returns400BadRequest", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents").attach("file", PDF, "a.pdf");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
    expect(mPut).not.toHaveBeenCalled();
  });

  it("upload_missingFile_returns400BadRequest", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents").field("type", "invoice");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("upload_typeWithPathChars_returns400", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents").field("type", "../x").attach("file", PDF, "a.pdf");
    expect(res.status).toBe(400);
    expect(mPut).not.toHaveBeenCalled();
  });

  it("upload_disguisedExecutable_returns400BadFileAndNothingStored", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents")
      .field("type", "invoice").attach("file", Buffer.from("MZ\x90\x00"), "invoice.pdf");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_FILE", message: "Loại file không được hỗ trợ" });
    expect(mPut).not.toHaveBeenCalled();
    expect(mp.document.create).not.toHaveBeenCalled();
  });

  it("upload_invalidInvoiceDate_returns400", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents")
      .field("type", "invoice").field("invoiceDate", "not-a-date").attach("file", PDF, "a.pdf");
    expect(res.status).toBe(400);
  });

  it("upload_dbInsertFails_removesUploadedObject", async () => {
    mp.document.create.mockRejectedValue(new Error("db down"));
    const res = await request(buildApp()).post("/api/shipments/documents").field("type", "invoice").attach("file", PDF, "a.pdf");
    expect(res.status).toBe(500);
    expect(removeObjectQuietly).toHaveBeenCalledWith(mPut.mock.calls[0][0]);
  });
});

describe("POST /documents/scan-tax", () => {
  it("scanTax_nonExcelFile_returns400BadFileSameBodyAsUnreadable", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents/scan-tax").attach("file", PDF, "x.pdf");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_FILE", message: "Không đọc được file Excel" });
    expect(readInvoiceTaxRowsFromExcel).not.toHaveBeenCalled();
  });

  it("scanTax_unreadableExcel_returns400BadFile", async () => {
    (readInvoiceTaxRowsFromExcel as any).mockRejectedValue(new Error("corrupt"));
    const res = await request(buildApp()).post("/api/shipments/documents/scan-tax").attach("file", XLSX, "x.xlsx");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_FILE", message: "Không đọc được file Excel" });
  });

  it("scanTax_noFile_returns400BadRequest", async () => {
    const res = await request(buildApp()).post("/api/shipments/documents/scan-tax");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("scanTax_matchedTracking_flagsNeedsTaxPersistently", async () => {
    (readInvoiceTaxRowsFromExcel as any).mockResolvedValue([{ trackingCode: "T1", itemName: "Áo", price: 1000, bill: "GE" }]);
    mp.tracking.findMany.mockResolvedValue([{ id: "t1", code: "T1", needsTax: false, taxCollected: false, packedAt: null, order: { code: "OD1", nick: null, customer: { name: "C" }, items: [] } }]);
    mp.taxRowNote.findMany.mockResolvedValue([]);
    const res = await request(buildApp()).post("/api/shipments/documents/scan-tax").attach("file", XLSX, "x.xlsx");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ trackingId: "t1", orderCode: "OD1", matchedBy: "tracking", unmatched: false });
    expect(mp.tracking.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["t1"] } }, data: { needsTax: true } });
  });
});

describe("month-based endpoints", () => {
  it("taxAudit_badMonth_returns400BadRequest", async () => {
    const res = await request(buildApp()).get("/api/shipments/tax-audit?month=2026-3");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("invoiceChecklist_missingMonth_returns400BadRequest", async () => {
    const res = await request(buildApp()).get("/api/shipments/invoice-checklist");
    expect(res.status).toBe(400);
  });
});

describe("tax config + notes", () => {
  it("putTaxConfig_invalidUrl_returns400BadUrl", async () => {
    const res = await request(buildApp()).put("/api/shipments/tax-config").send({ sheetUrl: "not a sheet" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_URL", message: "Link Google Sheet không hợp lệ" });
  });

  it("putNote_clearingBothFields_deletesExistingRow", async () => {
    mp.taxRowNote.findUnique.mockResolvedValue({ trackingCode: "T1", note: "x", taxCollected: false });
    const res = await request(buildApp()).put("/api/shipments/tax-rows/T1/note").send({ note: "  " });
    expect(res.body).toEqual({ trackingCode: "T1", note: null, taxCollected: false });
    expect(mp.taxRowNote.delete).toHaveBeenCalledWith({ where: { trackingCode: "T1" } });
  });

  it("putNote_onlyTaxCollected_keepsExistingNote", async () => {
    mp.taxRowNote.findUnique.mockResolvedValue({ trackingCode: "T1", note: "giữ", taxCollected: false });
    mp.taxRowNote.upsert.mockResolvedValue({ trackingCode: "T1", note: "giữ", taxCollected: true });
    const res = await request(buildApp()).put("/api/shipments/tax-rows/T1/note").send({ taxCollected: true });
    expect(res.body).toEqual({ trackingCode: "T1", note: "giữ", taxCollected: true });
    expect(mp.taxRowNote.upsert.mock.calls[0][0].update).toEqual({ note: "giữ", taxCollected: true, updatedBy: "u1" });
  });
});

describe("GET /documents/:id/download", () => {
  it("download_unknownId_returns404NotFound", async () => {
    mp.document.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).get("/api/shipments/documents/x/download");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "NOT_FOUND" });
  });
});
