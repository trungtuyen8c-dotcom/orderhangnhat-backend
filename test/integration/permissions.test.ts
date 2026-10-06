import { api, createCustomer, createOrder, createUser, login } from "./helpers.js";

// S5-04 (backend): quyền đọc từ role_permissions thật + cache Redis thật.
describe("permission: orders.update_status", () => {
  let admin: string;
  let sale: { id: string; token: string };
  let orderId: string;

  beforeAll(async () => {
    admin = (await login()).token;
    sale = await createUser(admin, "sale");
    orderId = (await createOrder(sale.token, (await createCustomer(admin)).id)).id;
  });

  it("roleWithoutUpdateStatus_transitionAction_403AndStatusUnchanged", async () => {
    const r = await api(sale.token).post(`/orders/${orderId}/deposit`);
    expect(r.status).toBe(403);
    expect((await api(admin).get(`/orders/${orderId}`)).body.status).toBe("quoted");
  });

  it("roleWithoutUpdateStatus_transitionsEndpoint_emptyActionsNoCorrect", async () => {
    const r = await api(sale.token).get(`/orders/${orderId}/transitions`);
    expect(r.status).toBe(200);
    expect(r.body.actions).toEqual([]);
    expect(r.body.canCorrect).toBe(false);
  });

  it("orderList_allowedActions_emptyForSale_filledForAdmin", async () => {
    const mine = (await api(sale.token).get("/orders")).body.find((o: { id: string }) => o.id === orderId);
    expect(mine.allowedActions).toEqual([]);
    const adm = (await api(admin).get("/orders")).body.find((o: { id: string }) => o.id === orderId);
    expect(adm.allowedActions).toHaveLength(3);
  });

  it("patchStatus_withoutPermission_403", async () => {
    expect((await api(sale.token).patch(`/orders/${orderId}/status`, { status: "deposited" })).status).toBe(403);
  });

  it("delivery_hasUpdateStatusButNotCorrection", async () => {
    const d = await createUser(admin, "delivery");
    const t = await api(d.token).get(`/orders/${orderId}/transitions`);
    // delivery không có orders.read -> 403 ở endpoint transitions, nhưng list vẫn có allowedActions
    if (t.status === 200) expect(t.body.canCorrect).toBe(false);
    else expect(t.status).toBe(403);
    const row = (await api(d.token).get("/orders")).body.find((o: { id: string }) => o.id === orderId);
    expect(row.allowedActions.length).toBeGreaterThan(0);
  });

  it("roleChange_takesEffectImmediately_permissionCacheInvalidated", async () => {
    // Given: viewer không được chuyển bước
    const u = await createUser(admin, "viewer");
    expect((await api(u.token).post(`/orders/${orderId}/deposit`)).status).toBe(403);
    // When: admin gán thêm role delivery
    expect((await api(admin).post(`/admin/users/${u.id}/roles`, { roleKeys: ["viewer", "delivery"] })).status).toBe(200);
    // Then: cùng token, không cần đăng nhập lại
    const r = await api(u.token).post(`/orders/${orderId}/deposit`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("deposited");
  });

  it("noPermission_adminEndpoints_403", async () => {
    expect((await api(sale.token).get("/admin/users")).status).toBe(403);
    expect((await api(sale.token).post("/accounting/wallets", { name: "x", currency: "VND" })).status).toBe(403);
  });
});
