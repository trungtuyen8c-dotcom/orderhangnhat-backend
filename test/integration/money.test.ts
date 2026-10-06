import { api, createCustomer, createOrder, createUser, createWallet, login, prisma, walletBalance } from "./helpers.js";

// S5-02: tiền phải đúng tuyệt đối khi có request đồng thời (SELECT ... FOR UPDATE + increment atomic).
describe("money: atomicity dưới tải đồng thời", () => {
  let token: string;
  beforeAll(async () => { token = (await login()).token; });

  it("parallelPayments_10Concurrent_walletBalanceExact", async () => {
    // Given
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const o = await createOrder(token, c.id, [{ name: "Ao", unitPriceJpy: 10000, qty: 2 }]);
    // When: 10 phiếu thu cùng lúc
    const res = await Promise.all(Array.from({ length: 10 }, () =>
      api(token).post(`/accounting/orders/${o.id}/payments`, { type: "deposit", amount: 100000, walletId: w.id })));
    // Then
    expect(res.map((r) => r.status)).toEqual(Array(10).fill(201));
    expect(await walletBalance(w.id)).toBe(1_000_000);
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(10);
  });

  it("parallelDepositConfirm_creditedExactlyOnce", async () => {
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const dep = await api(token).post(`/accounting/customers/${c.id}/deposits`, { amount: 300000, walletId: w.id });
    expect(dep.status).toBe(201);
    const res = await Promise.all(Array.from({ length: 5 }, () => api(token).post(`/accounting/customer-deposits/${dep.body.id}/confirm`)));
    // Xác nhận lại là idempotent: không request nào lỗi 5xx, số dư chỉ cộng 1 lần.
    expect(res.every((r) => r.status < 500)).toBe(true);
    expect(res.some((r) => r.status === 200)).toBe(true);
    expect(await walletBalance(w.id)).toBe(300000);
  });

  it("deleteOrder_withPayments_409HasPaymentsWithoutForce", async () => {
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const o = await createOrder(token, c.id);
    expect((await api(token).post(`/accounting/orders/${o.id}/payments`, { type: "deposit", amount: 50000, walletId: w.id })).status).toBe(201);
    const res = await api(token).delete(`/orders/${o.id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("HAS_PAYMENTS");
    expect(await walletBalance(w.id)).toBe(50000);
  });

  it("forceDeleteOrder_reversesPaymentsButKeepsManualCardTxns", async () => {
    // Given: 5 phiếu thu 100k + 1 giao dịch thẻ nhập tay gắn đơn
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const o = await createOrder(token, c.id);
    await Promise.all(Array.from({ length: 5 }, () =>
      api(token).post(`/accounting/orders/${o.id}/payments`, { type: "deposit", amount: 100000, walletId: w.id })));
    const manual = await api(token).post("/accounting/wallet-txns", { walletId: w.id, category: "Chi khác", amount: 50000, refOrderId: o.id });
    expect([200, 201]).toContain(manual.status);
    const before = await walletBalance(w.id);
    // When
    const del = await api(token).delete(`/orders/${o.id}?force=1`);
    // Then: chỉ hoàn đúng 500k phiếu thu, giao dịch tay vẫn còn và không bị hoàn
    expect(del.status).toBe(200);
    expect(before - (await walletBalance(w.id))).toBe(500000);
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0);
    expect(await prisma.walletTxn.count({ where: { walletId: w.id, category: "Chi khác" } })).toBe(1);
  });

  it("forceDelete_nonAdminWithOrdersDelete_403AndNothingReversed", async () => {
    // Given: role tự tạo có orders.delete nhưng không phải admin
    const role = await api(token).post("/admin/roles", { key: "it_deleter", name: "IT deleter", permissionKeys: ["orders.delete"] });
    expect(role.status).toBe(201);
    const u = await createUser(token, "it_deleter");
    const c = await createCustomer(token);
    const w = await createWallet(token);
    const o = await createOrder(token, c.id);
    await api(token).post(`/accounting/orders/${o.id}/payments`, { type: "deposit", amount: 70000, walletId: w.id });
    // When
    const res = await api(u.token).delete(`/orders/${o.id}?force=1`);
    // Then
    expect(res.status).toBe(403);
    expect(await walletBalance(w.id)).toBe(70000);
    expect(await prisma.order.findUnique({ where: { id: o.id } })).not.toBeNull();
  });
});
