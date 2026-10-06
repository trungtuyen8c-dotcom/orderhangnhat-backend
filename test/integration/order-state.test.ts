import { api, createCustomer, createOrder, createUser, login } from "./helpers.js";

const CHAIN: [string, string][] = [
  ["deposit", "deposited"], ["start-purchasing", "purchasing"], ["mark-purchased", "purchased"],
  ["receive-jp", "jp_warehouse"], ["start-customs", "customs"], ["complete-tax", "tax_done"],
  ["receive-vn", "vn_warehouse"], ["deliver", "delivered"], ["complete", "completed"], ["close", "closed"],
];

const actionsOf = (body: { actions?: { action: string }[] }) => (body.actions ?? []).map((a) => a.action).sort();

describe("order state machine (S5-03, API + DB thật)", () => {
  let admin: string;
  let sale: { id: string; token: string };
  let delivery: { id: string; token: string };
  let customerId: string;
  const newOrder = () => createOrder(sale.token, customerId);

  beforeAll(async () => {
    admin = (await login()).token;
    sale = await createUser(admin, "sale");
    delivery = await createUser(admin, "delivery");
    customerId = (await createCustomer(admin)).id;
  });

  it("create_bySale_startsQuotedWithThreeAllowedActions", async () => {
    const o = await newOrder();
    expect(o.status).toBe("quoted");
    const t = await api(admin).get(`/orders/${o.id}/transitions`);
    expect(t.status).toBe(200);
    expect(actionsOf(t.body)).toEqual(["cancel", "deposit", "start-purchasing"]);
    expect(t.body.canCorrect).toBe(true);
  });

  it("fullChain_quotedToClosed_eachStep200ThenTerminal", async () => {
    const o = await newOrder();
    for (const [action, to] of CHAIN) {
      const r = await api(delivery.token).post(`/orders/${o.id}/${action}`);
      expect({ action, status: r.status, to: r.body.status }).toEqual({ action, status: 200, to });
    }
    // closed là trạng thái cuối
    const cancel = await api(admin).post(`/orders/${o.id}/cancel`);
    expect(cancel.status).toBe(409);
    const t = await api(admin).get(`/orders/${o.id}/transitions`);
    expect(t.body.actions).toEqual([]);
  });

  it("invalidJump_quotedToCustoms_409StateInvalidTransition", async () => {
    const o = await newOrder();
    const r = await api(admin).post(`/orders/${o.id}/start-customs`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("STATE_INVALID_TRANSITION");
    expect((await api(admin).get(`/orders/${o.id}`)).body.status).toBe("quoted");
  });

  it("patchStatus_freeJump_409_butValidStep_200", async () => {
    const o = await newOrder();
    expect((await api(admin).patch(`/orders/${o.id}/status`, { status: "completed" })).status).toBe(409);
    const ok = await api(admin).patch(`/orders/${o.id}/status`, { status: "deposited" });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("deposited");
  });

  it("cancel_fromQuotedOrDeposited_200_fromPurchasing_409", async () => {
    const a = await newOrder();
    expect((await api(admin).post(`/orders/${a.id}/cancel`)).body.status).toBe("cancelled");
    const b = await newOrder();
    await api(admin).post(`/orders/${b.id}/deposit`);
    expect((await api(admin).post(`/orders/${b.id}/cancel`)).status).toBe(200);
    const c = await newOrder();
    await api(admin).post(`/orders/${c.id}/start-purchasing`);
    expect((await api(admin).post(`/orders/${c.id}/cancel`)).status).toBe(409);
  });

  it("cancelled_isTerminal_noActionsAnd409", async () => {
    const o = await newOrder();
    await api(admin).post(`/orders/${o.id}/cancel`);
    expect((await api(admin).get(`/orders/${o.id}/transitions`)).body.actions).toEqual([]);
    expect((await api(admin).post(`/orders/${o.id}/deposit`)).status).toBe(409);
  });

  it("concurrentSameAction_exactlyOne200_rest409", async () => {
    const o = await newOrder();
    const res = await Promise.all(Array.from({ length: 5 }, () => api(admin).post(`/orders/${o.id}/deposit`)));
    const codes = res.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409, 409, 409]);
    // bấm lại action đã làm -> 409
    expect((await api(admin).post(`/orders/${o.id}/deposit`)).status).toBe(409);
  });

  it("unknownOrder_404_unknownAction_404", async () => {
    expect((await api(admin).post("/orders/00000000-0000-4000-8000-000000000000/deposit")).status).toBe(404);
    const o = await newOrder();
    expect((await api(admin).post(`/orders/${o.id}/khong-co-action`)).status).toBe(404);
  });

  it("correction_nonAdmin_403_missingReason_400", async () => {
    const o = await newOrder();
    expect((await api(delivery.token).post(`/orders/${o.id}/status-correction`, { status: "delivered", reason: "nham buoc" })).status).toBe(403);
    expect((await api(admin).post(`/orders/${o.id}/status-correction`, { status: "delivered" })).status).toBe(400);
    expect((await api(admin).post(`/orders/${o.id}/status-correction`, { status: "delivered", reason: "x" })).status).toBe(400);
  });

  it("correction_admin_anyStatusWithReason_auditHasBeforeAfterReasonRequestId", async () => {
    // Given: đơn đã closed
    const o = await newOrder();
    for (const [action] of CHAIN) await api(admin).post(`/orders/${o.id}/${action}`);
    // When
    const r = await api(admin).post(`/orders/${o.id}/status-correction`, { status: "delivered", reason: "Khach chua nhan du hang" });
    // Then
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("delivered");
    const audit = await api(admin).get("/admin/audit?page=1&pageSize=100&action=order.status");
    expect(audit.status).toBe(200);
    const mine = audit.body.items.filter((a: { targetId?: string; metadata?: { orderId?: string } }) => JSON.stringify(a).includes(o.id));
    const corr = mine.find((a: { action: string }) => a.action === "order.status_corrected");
    expect(corr?.metadata).toMatchObject({ before: { status: "closed" }, after: { status: "delivered" }, reason: "Khach chua nhan du hang" });
    expect(corr.metadata.requestId).toBeTruthy();
    expect(mine.filter((a: { action: string }) => a.action === "order.status_changed")).toHaveLength(CHAIN.length);
  });
});
