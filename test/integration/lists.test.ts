import { api, createCustomer, createOrder, login, prisma } from "./helpers.js";

// Phân trang / lọc / summary chạy SQL thật (index + where build từ query).
describe("list endpoints: pagination, filter, summary", () => {
  let token: string;
  const customers: { id: string; name: string }[] = [];
  const orders: { id: string; code: string }[] = [];

  beforeAll(async () => {
    token = (await login()).token;
    for (const n of ["Alpha Lists", "Beta Lists", "Gamma Lists"]) customers.push(await createCustomer(token, n));
    for (let i = 0; i < 7; i++) orders.push(await createOrder(token, customers[i % 3].id, [{ name: `Mon ${i}`, unitPriceJpy: 100 * (i + 1), qty: 1 }]));
    await api(token).post(`/orders/${orders[0].id}/cancel`);
    await prisma.tracking.createMany({ data: [{ code: "ITTRACK0001" }, { code: "ITTRACK0002" }, { code: "ITTRACK0003" }] as never });
  });

  it("orders_withoutPage_returnsArray", async () => {
    const r = await api(token).get("/orders");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body).toHaveLength(7);
  });

  it("orders_paged_paginationMetaAndDisjointPages", async () => {
    const p1 = await api(token).get("/orders?page=1&pageSize=3&sort=code&order=asc");
    const p3 = await api(token).get("/orders?page=3&pageSize=3&sort=code&order=asc");
    expect(p1.body.pagination).toMatchObject({ page: 1, pageSize: 3, total: 7, totalPages: 3 });
    expect(p1.body.items).toHaveLength(3);
    expect(p3.body.items).toHaveLength(1);
    const codes = p1.body.items.map((o: { code: string }) => o.code);
    expect(codes).toEqual([...codes].sort());
    expect(codes).not.toContain(p3.body.items[0].code);
  });

  it("orders_pageSizeClampedToMax", async () => {
    const r = await api(token).get("/orders?page=1&pageSize=100000");
    expect(r.body.pagination.pageSize).toBeLessThanOrEqual(200);
  });

  it("orders_summary_hasMonths", async () => {
    const r = await api(token).get("/orders?page=1&pageSize=5&summary=1&sort=orderDate&order=desc");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.summary?.months)).toBe(true);
  });

  it("orders_filterStatusAndCustomer", async () => {
    const cancelled = await api(token).get("/orders?status=cancelled");
    expect(cancelled.body.map((o: { id: string }) => o.id)).toEqual([orders[0].id]);
    const quoted = await api(token).get("/orders?page=1&status=quoted");
    expect(quoted.body.pagination.total).toBe(6);
    const byCustomer = await api(token).get(`/orders?customerId=${customers[1].id}`);
    expect(byCustomer.body).toHaveLength(2);
  });

  it("orders_filterQByCode", async () => {
    const r = await api(token).get(`/orders?q=${orders[4].code}`);
    expect(r.body.map((o: { code: string }) => o.code)).toContain(orders[4].code);
  });

  it("orders_invalidStatus_400", async () => {
    expect((await api(token).get("/orders?status=khong_co")).status).toBe(400);
  });

  it("orders_facets", async () => {
    const r = await api(token).get("/orders/facets");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.nicks)).toBe(true);
  });

  it("customers_pagedLiteSearch", async () => {
    const r = await api(token).get("/customers?page=1&pageSize=2&lite=1&q=Lists");
    expect(r.status).toBe(200);
    expect(r.body.pagination.total).toBe(3);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].debt).toBeUndefined();
    const one = await api(token).get("/customers?page=1&lite=1&q=Beta");
    expect(one.body.items.map((c: { name: string }) => c.name)).toEqual(["Beta Lists"]);
  });

  it("customers_withoutPage_returnsArray", async () => {
    const r = await api(token).get("/customers");
    expect(Array.isArray(r.body)).toBe(true);
    expect(r.body.length).toBeGreaterThanOrEqual(3);
  });

  it("trackings_paged", async () => {
    const r = await api(token).get("/trackings?page=1&pageSize=2&sort=createdAt");
    expect(r.status).toBe(200);
    expect(r.body.pagination.total).toBeGreaterThanOrEqual(3);
    expect(r.body.items).toHaveLength(2);
  });

  it("audit_pagedAndFilteredByAction_defaultIsArray", async () => {
    const p = await api(token).get("/admin/audit?page=1&pageSize=5&action=order");
    expect(p.status).toBe(200);
    expect(p.body.items.length).toBeGreaterThan(0);
    expect(p.body.items.every((a: { action: string }) => a.action.startsWith("order"))).toBe(true);
    expect(Array.isArray((await api(token).get("/admin/audit")).body)).toBe(true);
  });
});
