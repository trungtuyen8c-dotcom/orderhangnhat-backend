import { api, createCustomer, createOrder, createUser, createWallet, login, waitFor } from "./helpers.js";

type Notif = { id: string; type: string; title: string; read: boolean };
const list = async (token: string) => (await api(token).get("/me/notifications")).body as { items: Notif[]; unread: number };

// Event bus -> enqueue BullMQ -> worker resolve người nhận (DB) -> lưu Redis -> GET /me/notifications.
describe("notifications end-to-end (queue + worker thật)", () => {
  let admin: string;
  beforeAll(async () => { admin = (await login()).token; });

  it("depositByAdmin_accountantReceives_adminDoesNotSeeOwn", async () => {
    // Given
    const kt = await createUser(admin, "accountant");
    const sale = await createUser(admin, "sale");
    const c = await createCustomer(admin);
    const w = await createWallet(admin);
    // When
    expect((await api(admin).post(`/accounting/customers/${c.id}/deposits`, { amount: 123000, walletId: w.id })).status).toBe(201);
    // Then
    const got = await waitFor(async () => (await list(kt.token)).items.find((n) => n.type === "deposit.created"));
    expect(got.read).toBe(false);
    expect((await list(admin)).items.some((n) => n.type === "deposit.created")).toBe(false);
    // sale không có accounting.reconcile -> không nhận
    expect((await list(sale.token)).items.some((n) => n.type === "deposit.created")).toBe(false);
  });

  it("markRead_allVisible_unreadZero", async () => {
    const kt = await createUser(admin, "accountant");
    const c = await createCustomer(admin);
    const w = await createWallet(admin);
    // Role-based: user mới vẫn thấy thông báo cũ của role -> chờ đúng thông báo mới về rồi mới đánh dấu đọc.
    const before = (await list(kt.token)).items.length;
    await api(admin).post(`/accounting/customers/${c.id}/deposits`, { amount: 5000, walletId: w.id });
    await waitFor(async () => (await list(kt.token)).items.length > before);
    expect((await api(kt.token).post("/me/notifications/read", {})).status).toBe(200);
    expect((await list(kt.token)).unread).toBe(0);
  });

  it("orderStatusChangedByOther_saleOfOrderReceives", async () => {
    const sale = await createUser(admin, "sale");
    const o = await createOrder(sale.token, (await createCustomer(admin)).id);
    expect((await api(admin).post(`/orders/${o.id}/deposit`)).status).toBe(200);
    const n = await waitFor(async () => (await list(sale.token)).items.find((x) => x.type === "order.status_changed"));
    expect(n.title).toContain(o.code);
  });

  it("noAuth_401", async () => {
    expect((await api().get("/me/notifications")).status).toBe(401);
  });
});
