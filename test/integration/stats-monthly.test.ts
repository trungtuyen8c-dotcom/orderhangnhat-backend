import { api, createCustomer, createOrder, createUser, login } from "./helpers.js";

type Month = { month: string; waiting: number; shipping: number; done: number; cancelled: number; revenueVnd?: number; spendJpy?: number };

describe("GET /stats/monthly (M4-2, API + DB thật)", () => {
  let admin: string;

  beforeAll(async () => {
    admin = (await login()).token;
    const c = await createCustomer(admin);
    await createOrder(admin, c.id, [{ name: "Ao", unitPriceJpy: 1000, qty: 2 }]);
    const o2 = await createOrder(admin, c.id, [{ name: "Quan", unitPriceJpy: 500, qty: 1 }]);
    expect((await api(admin).post(`/orders/${o2.id}/cancel`)).status).toBe(200);
  });

  it("monthly_admin_denseMonthsWithGroupsAndMoney", async () => {
    const r = await api(admin).get("/stats/monthly?months=6");
    expect(r.status).toBe(200);
    const months = r.body.months as Month[];
    expect(months).toHaveLength(6);
    const cur = months[5];
    expect(cur.waiting).toBe(1);
    expect(cur.cancelled).toBe(1);
    // đơn hủy không tính vào chi ¥ / doanh thu
    expect(cur.spendJpy).toBe(2000);
    expect(cur.revenueVnd).toBeGreaterThan(0);
    expect(months[0].waiting + months[0].shipping + months[0].done + months[0].cancelled).toBe(0);
  });

  it("monthly_roleWithoutOrdersRead_countsOnlyNoMoney", async () => {
    const vn = await createUser(admin, "vn_warehouse");
    const r = await api(vn.token).get("/stats/monthly");
    expect(r.status).toBe(200);
    expect(r.body.months).toHaveLength(12);
    expect(r.body.months[11]).not.toHaveProperty("revenueVnd");
    expect(r.body.months[11]).not.toHaveProperty("spendJpy");
  });

  it("monthly_noAuth_401", async () => {
    expect((await api().get("/stats/monthly")).status).toBe(401);
  });
});
