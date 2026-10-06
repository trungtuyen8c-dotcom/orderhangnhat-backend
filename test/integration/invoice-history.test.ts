import { api, createCustomer, createOrder, createUser, login, prisma } from "./helpers.js";

// N1 "Hàng chưa lên invoice": xuất invoice ghi lịch sử (Invoice/InvoiceItem) trong transaction,
// GET /invoices/pending liệt kê tracking của đơn đã mua trong tháng (giờ VN) chưa từng lên invoice nào.
describe("invoice history + hàng chưa lên invoice", () => {
  let token: string;
  let customerName: string;
  const trk: Record<string, string> = {};
  const ord: Record<string, { id: string; code: string }> = {};

  async function trackingOf(orderId: string) {
    return prisma.tracking.findFirstOrThrow({ where: { orderId } });
  }
  async function setup(key: string, code: string, orderDate: string, items = [{ name: `Mon ${key}`, unitPriceJpy: 1000, qty: 2 }]) {
    const o = await createOrder(token, (await prisma.customer.findFirstOrThrow({ where: { name: customerName } })).id, items);
    await prisma.order.update({ where: { id: o.id }, data: { orderDate: new Date(orderDate), status: "purchased" } });
    const t = await trackingOf(o.id);
    expect((await api(token).patch(`/trackings/${t.id}`, { code })).status).toBe(200);
    ord[key] = o; trk[key] = t.id;
  }
  const pending = async (q = "") => {
    const r = await api(token).get(`/invoices/pending?month=2026-06&page=1&pageSize=50${q}`);
    expect(r.status).toBe(200);
    return r.body as { items: { trackingId: string; trackingCode: string; orderCode: string; amountJpy: number }[]; pagination: { total: number }; totals: Record<string, number> };
  };
  const pendingIds = async () => (await pending()).items.map((i) => i.trackingId);

  beforeAll(async () => {
    token = (await login()).token;
    const c = await createCustomer(token, "Khach Invoice IT");
    customerName = c.name;
    // VN 01/06 01:00 (UTC 31/05 18:00) -> thuộc tháng 6 giờ VN
    await setup("a", "IT-INV-A", "2026-05-31T18:00:00Z");
    await setup("b", "IT-INV-WRONG", "2026-06-15T03:00:00Z");
    await setup("c", "IT-INV-C", "2026-06-20T03:00:00Z", [{ name: "Giay", unitPriceJpy: 500, qty: 1 }]);
    // VN 01/07 00:30 -> tháng 7, không lấy
    await setup("july", "IT-INV-JULY", "2026-06-30T17:30:00Z");
    // Đơn hủy -> không lấy
    await setup("cancel", "IT-INV-CANCEL", "2026-06-10T03:00:00Z");
    await prisma.order.update({ where: { id: ord.cancel.id }, data: { status: "cancelled" } });
    // Ký gửi (không có món mua) -> không lấy
    const cons = await api(token).post("/orders/consignment", { customerId: c.id, code: "IT-INV-CONSIGN" });
    expect(cons.status).toBe(201);
    await prisma.order.update({ where: { id: cons.body.id }, data: { orderDate: new Date("2026-06-11T03:00:00Z") } });
  });

  it("pending_givenMonth_thenOnlyPurchasedNeverInvoicedInVnMonth", async () => {
    const body = await pending();
    expect(body.items.map((i) => i.trackingId).sort()).toEqual([trk.a, trk.b, trk.c].sort());
    expect(body.items.map((i) => i.orderCode)).toEqual([ord.a.code, ord.b.code, ord.c.code]);
    expect(body.totals).toEqual({ trackings: 3, orders: 3, unpacked: 3, amountJpy: 4500 });
    expect(body.pagination.total).toBe(3);
  });

  it("pending_givenSearchAndPaging_thenFiltered", async () => {
    expect((await pending("&q=wrong")).items.map((i) => i.trackingId)).toEqual([trk.b]);
    const p2 = await api(token).get("/invoices/pending?month=2026-06&page=2&pageSize=2");
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.totals.trackings).toBe(3);
    expect((await api(token).get("/invoices/pending?month=2026-6")).status).toBe(400);
  });

  it("export_givenTrackings_thenResponseUnchangedAndHistoryRecorded", async () => {
    const r = await api(token).post("/trackings/invoice", { ids: [trk.a, trk.c], note: "GB-260601" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      items: [
        { no: 1, name: "Mon a", origin: "", unitPriceJpy: 1000, unit: "pcs", qty: 2, amount: 2000 },
        { no: 2, name: "Giay", origin: "", unitPriceJpy: 500, unit: "pcs", qty: 1, amount: 500 },
      ],
      total: 2500, consignees: [customerName], addresses: [],
    });
    const inv = await prisma.invoice.findFirstOrThrow({ include: { items: true } });
    expect(inv).toMatchObject({ note: "GB-260601", trackingCount: 2, lineCount: 2 });
    expect(Number(inv.totalJpy)).toBe(2500);
    expect(inv.items.map((i) => i.trackingCode).sort()).toEqual(["IT-INV-A", "IT-INV-C"]);
    expect(inv.items.find((i) => i.trackingId === trk.a)).toMatchObject({ orderId: ord.a.id, orderCode: ord.a.code, customerName });
    expect(await pendingIds()).toEqual([trk.b]);
    const audit = await prisma.accessAudit.findFirst({ where: { action: "invoice.exported", targetId: inv.id } });
    expect(audit).not.toBeNull();
  });

  it("fixWrongCode_thenStillPendingUntilNextExport", async () => {
    expect((await api(token).patch(`/trackings/${trk.b}`, { code: "IT-INV-B" })).status).toBe(200);
    const body = await pending();
    expect(body.items.map((i) => [i.trackingId, i.trackingCode])).toEqual([[trk.b, "IT-INV-B"]]);
    expect((await api(token).post("/trackings/invoice", { ids: [trk.b] })).status).toBe(200);
    expect(await pendingIds()).toEqual([]);
  });

  it("history_listAndDetail", async () => {
    const list = await api(token).get("/invoices?page=1&pageSize=10");
    expect(list.status).toBe(200);
    expect(list.body.pagination.total).toBe(2);
    expect(list.body.items[0]).toMatchObject({ trackingCount: 1, totalJpy: 2000, createdByName: expect.any(String) });
    const first = list.body.items[1];
    const d = await api(token).get(`/invoices/${first.id}`);
    expect(d.status).toBe(200);
    expect(d.body.items.map((i: { orderCode: string }) => i.orderCode)).toEqual([ord.a.code, ord.c.code].sort());
    expect((await api(token).get("/invoices/00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("deleteInvoicedTracking_thenHistoryKeptLinkCleared", async () => {
    expect((await api(token).delete(`/trackings/${trk.c}`)).status).toBe(200);
    const item = await prisma.invoiceItem.findFirstOrThrow({ where: { trackingCode: "IT-INV-C" } });
    expect(item.trackingId).toBeNull();
    expect(item.orderCode).toBe(ord.c.code);
  });

  it("permissions_vnWarehouseSeesPage_customsForbidden", async () => {
    const vn = await createUser(token, "vn_warehouse");
    expect((await api(vn.token).get("/invoices/pending?month=2026-06")).status).toBe(200);
    expect((await api(vn.token).get("/invoices")).status).toBe(200);
    const customs = await createUser(token, "customs");
    expect((await api(customs.token).get("/invoices/pending?month=2026-06")).status).toBe(403);
    expect((await api(customs.token).get("/invoices")).status).toBe(403);
  });
});
