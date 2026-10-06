import request from "supertest";
import { v4 as uuid } from "uuid";
import { Readable } from "stream";
import { minio } from "../../src/infrastructure/minio.js";
import { api, createUser, login, prisma, server } from "./helpers.js";

// MinIO không chạy trong integration test. setup.ts đã nạp app (cache module) trước file này nên vi.mock không
// thay được documentStorage -> spy thẳng vào client minio dùng chung, giả lập kho object bằng Map.
const store = new Map<string, number>();
beforeAll(() => {
  vi.spyOn(minio, "putObject").mockImplementation((async (_b: string, key: string, _s: unknown, size: number) => { store.set(key, size); return { etag: "x", versionId: null }; }) as never);
  vi.spyOn(minio, "getObject").mockImplementation((async () => Readable.from([Buffer.from("%PDF-1.4")])) as never);
  vi.spyOn(minio, "removeObject").mockImplementation((async (_b: string, key: string) => { store.delete(key); }) as never);
});
afterAll(() => vi.restoreAllMocks());

const PDF = Buffer.from("%PDF-1.4\ninvoice");

describe("M7-1: hóa đơn mua đính theo tracking", () => {
  let admin: string;
  let trackingId: string;
  beforeAll(async () => {
    admin = (await login()).token;
    trackingId = (await prisma.tracking.create({ data: { id: uuid(), code: `IT-DOC-${Date.now()}` } })).id;
  });

  const upload = (token: string, tid = trackingId, buf = PDF, name = "hoa don.pdf") =>
    request(server).post(`/api/shipments/trackings/${tid}/documents`).set("Authorization", `Bearer ${token}`).attach("file", buf, { filename: name });

  it("upload_list_count_download_delete_roundTrip", async () => {
    const up = await upload(admin);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ trackingId, type: "purchase_invoice", fileName: "hoa don.pdf" });
    const row = await prisma.document.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(store.has(row.objectKey)).toBe(true);

    const list = await api(admin).get(`/shipments/trackings/${trackingId}/documents`);
    expect(list.body.map((d: { id: string }) => d.id)).toEqual([up.body.id]);

    const counts = await api(admin).post("/shipments/tracking-documents/counts", { trackingIds: [trackingId, uuid()] });
    expect(counts.body).toEqual({ [trackingId]: 1 });

    const dl = await api(admin).get(`/shipments/documents/${up.body.id}/download`);
    expect(dl.status).toBe(200);

    const del = await api(admin).delete(`/shipments/trackings/${trackingId}/documents/${up.body.id}`);
    expect(del.status).toBe(200);
    expect(await prisma.document.count({ where: { id: up.body.id } })).toBe(0);
    expect(store.has(row.objectKey)).toBe(false);
    expect(await prisma.accessAudit.count({ where: { targetId: up.body.id, action: { in: ["document.uploaded", "document.deleted"] } } })).toBe(2);
  });

  it("deleteTracking_keepsFile_unlinks (onDelete SetNull)", async () => {
    const t = await prisma.tracking.create({ data: { id: uuid(), code: `IT-DOC2-${Date.now()}` } });
    const up = await upload(admin, t.id);
    expect(up.status).toBe(201);
    await prisma.tracking.delete({ where: { id: t.id } });
    const doc = await prisma.document.findUniqueOrThrow({ where: { id: up.body.id } });
    expect(doc.trackingId).toBeNull();
  });

  it("permissions_accountantCannotUpload_jpWarehouseCan", async () => {
    const acc = await createUser(admin, "accountant");
    expect((await upload(acc.token)).status).toBe(403);
    expect((await api(acc.token).get(`/shipments/trackings/${trackingId}/documents`)).status).toBe(403);
    const jp = await createUser(admin, "jp_warehouse");
    expect((await upload(jp.token)).status).toBe(201);
  });

  it("rejects_nonPdfImage_and_unknownTracking", async () => {
    expect((await upload(admin, trackingId, Buffer.from("a,b\n1,2"), "x.csv")).status).toBe(400);
    expect((await upload(admin, uuid())).status).toBe(404);
  });
});
