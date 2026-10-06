import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = { id: "u1" }; next(); },
}));
const { authorizeCalls } = vi.hoisted(() => ({ authorizeCalls: [] as string[] }));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: (...perms: string[]) => { authorizeCalls.push(perms.join("|")); return (_req: any, _res: any, next: any) => next(); },
}));
vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = {
    document: { create: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), deleteMany: vi.fn(), groupBy: vi.fn() },
    tracking: { findUnique: vi.fn() },
  };
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn() }));
vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));
vi.mock("../../integrations/minio/documentStorage.js", () => ({
  putObjectFromFile: vi.fn(), getObjectStream: vi.fn(), removeObjectQuietly: vi.fn(),
}));
vi.mock("../sheets/invoiceTaxSheet.service.js", () => ({ readInvoiceTaxRows: vi.fn(), readInvoiceTaxRowsFromExcel: vi.fn() }));

import { shipmentsRouter } from "./shipments.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { putObjectFromFile, removeObjectQuietly } from "../../integrations/minio/documentStorage.js";
import { errorHandler } from "../../app/errors/errorHandler.js";
import { toTrackingDocOut } from "./trackingDocuments.service.js";

const mp = prisma as any;
const T = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const PDF = Buffer.from("%PDF-1.4\nhello");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const XLSX = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/api/shipments", shipmentsRouter);
  a.use(errorHandler);
  return a;
};

beforeEach(() => {
  vi.clearAllMocks();
  mp.tracking.findUnique.mockResolvedValue({ id: T, code: "JP1" });
  mp.document.create.mockImplementation(async ({ data }: any) => ({ orderId: null, createdAt: new Date("2026-01-01"), ...data }));
});

describe("tracking documents routes", () => {
  it("routes_usesSamePermissionsAsGenericDocuments", () => {
    expect(authorizeCalls).toEqual(expect.arrayContaining(["shipments.upload_doc", "shipments.list"]));
  });

  it("upload_pdf_storesPurchaseInvoiceLinkedToTracking", async () => {
    const res = await request(app()).post(`/api/shipments/trackings/${T}/documents`).attach("file", PDF, { filename: "hoa don.pdf" });
    expect(res.status).toBe(201);
    const [key, , , mime] = (putObjectFromFile as any).mock.calls[0];
    expect(key).toMatch(/^documents\/purchase_invoice\/[0-9a-f-]{36}-hoa don\.pdf$/);
    expect(mime).toBe("application/pdf");
    expect(mp.document.create.mock.calls[0][0].data).toMatchObject({ type: "purchase_invoice", trackingId: T, uploadedBy: "u1" });
    expect(res.body).toMatchObject({ trackingId: T, fileName: "hoa don.pdf", type: "purchase_invoice" });
    expect(res.body.objectKey).toBeUndefined();
  });

  it("upload_image_accepted", async () => {
    const res = await request(app()).post(`/api/shipments/trackings/${T}/documents`).attach("file", PNG, { filename: "a.png" });
    expect(res.status).toBe(201);
  });

  it("upload_xlsx_rejectedBadFile_noMinioWrite", async () => {
    const res = await request(app()).post(`/api/shipments/trackings/${T}/documents`).attach("file", XLSX, { filename: "a.xlsx" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BAD_FILE");
    expect(putObjectFromFile).not.toHaveBeenCalled();
  });

  it("upload_unknownTracking_404_noMinioWrite", async () => {
    mp.tracking.findUnique.mockResolvedValue(null);
    const res = await request(app()).post(`/api/shipments/trackings/${T}/documents`).attach("file", PDF, { filename: "a.pdf" });
    expect(res.status).toBe(404);
    expect(putObjectFromFile).not.toHaveBeenCalled();
  });

  it("upload_dbFails_removesUploadedObject", async () => {
    mp.document.create.mockRejectedValue(new Error("db down"));
    const res = await request(app()).post(`/api/shipments/trackings/${T}/documents`).attach("file", PDF, { filename: "a.pdf" });
    expect(res.status).toBe(500);
    expect(removeObjectQuietly).toHaveBeenCalledWith((putObjectFromFile as any).mock.calls[0][0]);
  });

  it("upload_invalidTrackingId_400", async () => {
    const res = await request(app()).post(`/api/shipments/trackings/not-a-uuid/documents`).attach("file", PDF, { filename: "a.pdf" });
    expect(res.status).toBe(400);
  });

  it("list_returnsDocsOfTracking", async () => {
    mp.document.findMany.mockResolvedValue([{ id: D, type: "purchase_invoice", trackingId: T, orderId: null, objectKey: `documents/purchase_invoice/${D}-x.pdf`, uploadedBy: "u1", createdAt: new Date() }]);
    const res = await request(app()).get(`/api/shipments/trackings/${T}/documents`);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ id: D, fileName: "x.pdf" });
    expect(mp.document.findMany.mock.calls[0][0].where).toEqual({ trackingId: T });
  });

  it("delete_otherTrackingsDoc_404_noRemove", async () => {
    mp.document.findFirst.mockResolvedValue(null);
    const res = await request(app()).delete(`/api/shipments/trackings/${T}/documents/${D}`);
    expect(res.status).toBe(404);
    expect(removeObjectQuietly).not.toHaveBeenCalled();
  });

  it("delete_ok_deletesRowThenObject", async () => {
    mp.document.findFirst.mockResolvedValue({ id: D, type: "purchase_invoice", trackingId: T, objectKey: "documents/purchase_invoice/k.pdf" });
    mp.document.deleteMany.mockResolvedValue({ count: 1 });
    const res = await request(app()).delete(`/api/shipments/trackings/${T}/documents/${D}`);
    expect(res.status).toBe(200);
    expect(mp.document.deleteMany).toHaveBeenCalledWith({ where: { id: D, trackingId: T } });
    expect(removeObjectQuietly).toHaveBeenCalledWith("documents/purchase_invoice/k.pdf");
  });

  it("counts_groupsByTracking", async () => {
    mp.document.groupBy.mockResolvedValue([{ trackingId: T, _count: { _all: 3 } }]);
    const res = await request(app()).post("/api/shipments/tracking-documents/counts").send({ trackingIds: [T, T] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ [T]: 3 });
    expect(mp.document.groupBy.mock.calls[0][0].where).toEqual({ trackingId: { in: [T] } });
  });

  it("counts_emptyList_noQuery", async () => {
    const res = await request(app()).post("/api/shipments/tracking-documents/counts").send({ trackingIds: [] });
    expect(res.body).toEqual({});
    expect(mp.document.groupBy).not.toHaveBeenCalled();
  });

  it("counts_badIds_400", async () => {
    const res = await request(app()).post("/api/shipments/tracking-documents/counts").send({ trackingIds: ["x"] });
    expect(res.status).toBe(400);
  });
});

describe("toTrackingDocOut", () => {
  it("stripsUuidPrefixFromFileName", () => {
    const out = toTrackingDocOut({ id: D, type: "t", trackingId: T, orderId: null, objectKey: `documents/t/${D}-Hóa đơn (1).pdf`, uploadedBy: null, createdAt: new Date() });
    expect(out.fileName).toBe("Hóa đơn (1).pdf");
  });
});
