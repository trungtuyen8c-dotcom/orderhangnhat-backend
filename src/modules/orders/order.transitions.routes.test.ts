import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../infrastructure/prisma.js", () => ({
  prisma: {
    order: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
}));
let currentUser: { id: string; roles: string[] } = { id: "actor1", roles: ["staff"] };
let currentPerms: string[] = [];
vi.mock("../../middlewares/authenticate.js", () => ({
  authenticateEither: (req: any, _res: any, next: any) => { req.user = currentUser; next(); },
}));
vi.mock("../../middlewares/authorize.js", () => ({
  authorize: (perm: string) => (_req: any, res: any, next: any) =>
    currentPerms.includes(perm) ? next() : res.status(403).json({ error: "FORBIDDEN", message: `Thiếu quyền: ${perm}` }),
  hasPermission: async (_req: any, perm: string) => currentPerms.includes(perm),
}));
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn(), logAuditTx: vi.fn(), logOrder: vi.fn() }));
vi.mock("../../app/events/EventBus.js", () => ({ eventBus: { publish: vi.fn() } }));
vi.mock("./order.totals.js", () => ({ recomputeOrderTotals: vi.fn() }));
vi.mock("../accounting/orderCard.js", () => ({ applyOrderCardCharges: vi.fn(), reverseOrderCardCharges: vi.fn() }));
vi.mock("../accounting/wallet.service.js", () => ({ reversePaymentWallets: vi.fn() }));
vi.mock("../sheets/sheet.jobs.js", () => ({ queueCustomerSheetSync: vi.fn() }));
vi.mock("../tracking/tracking.repository.js", () => ({ claimOrCreateTracking: vi.fn() }));

import { ordersRouter } from "./orders.routes.js";
import { prisma } from "../../infrastructure/prisma.js";
import { logAuditTx, logOrder } from "../../app/audit.js";
import { eventBus } from "../../app/events/EventBus.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { USER_TRANSITIONS } from "./order.state.js";

const mockPrisma = prisma as any;
const mockAuditTx = logAuditTx as ReturnType<typeof vi.fn>;
const mockPublish = eventBus.publish as ReturnType<typeof vi.fn>;

const ORDER_ID = "11111111-1111-1111-1111-111111111111";
const CUSTOMER_ID = "22222222-2222-2222-2222-222222222222";
const FULL = ["orders.list", "orders.read", "orders.update", "orders.update_status"];

// tx riêng (khác prisma global) để chứng minh ghi status + audit đi qua transaction.
let tx: any;
let committed: boolean;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => { req.requestId = "req-1"; next(); });
  app.use("/api/orders", ordersRouter);
  return app;
}

function orderAt(status: string) {
  mockPrisma.order.findUnique.mockResolvedValue({ id: ORDER_ID, status, customerId: CUSTOMER_ID });
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { id: "actor1", roles: ["staff"] };
  currentPerms = [...FULL];
  committed = false;
  tx = {
    order: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(async () => ({ id: ORDER_ID, status: "after" })),
    },
  };
  mockPrisma.$transaction.mockImplementation(async (cb: any) => {
    const r = await cb(tx);
    committed = true;
    return r;
  });
  // event chỉ hợp lệ khi transaction đã commit
  mockPublish.mockImplementation(() => { expect(committed).toBe(true); });
});

describe("POST /orders/:id/:action", () => {
  it.each(USER_TRANSITIONS.map((t) => [t.from, t.action, t.to]))(
    "transition_givenOrderAt%s_whenPost%s_thenStatusBecomes%s",
    async (from, action, to) => {
      orderAt(from);

      await request(buildApp()).post(`/api/orders/${ORDER_ID}/${action}`).expect(200);

      expect(tx.order.updateMany).toHaveBeenCalledWith({ where: { id: ORDER_ID, status: from }, data: { status: to } });
      expect(mockPrisma.order.updateMany).not.toHaveBeenCalled();
    },
  );

  it("transition_givenValidStep_whenPost_thenAuditInsideTxWithBeforeAfterRequestIdAndAction", async () => {
    orderAt("quoted");

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/deposit`).expect(200);

    expect(mockAuditTx).toHaveBeenCalledWith(tx, {
      actorId: "actor1", targetId: ORDER_ID, action: "order.status_changed", entity: "order", requestId: "req-1",
      before: { status: "quoted" }, after: { status: "deposited" }, metadata: { transition: "deposit" },
    });
  });

  it("transition_givenValidStep_whenPost_thenAfterCommitHistoryAndEventButNoSheetSync", async () => {
    orderAt("purchased");

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/receive-jp`).expect(200);

    expect(logOrder).toHaveBeenCalledWith({
      orderId: ORDER_ID, actorId: "actor1", action: "status_changed",
      changes: [{ field: "status", old: "purchased", new: "jp_warehouse", action: "receive-jp" }],
    });
    expect(mockPublish).toHaveBeenCalledWith({
      eventName: "order.status_changed", actorId: "actor1", entityType: "order", entityId: ORDER_ID,
      metadata: { from: "purchased", to: "jp_warehouse", action: "receive-jp" },
    });
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it.each([
    ["quoted", "mark-purchased"],
    ["deposited", "deliver"],
    ["purchased", "start-purchasing"],
    ["vn_warehouse", "receive-jp"],
    ["closed", "close"],
    ["cancelled", "quote"],
    ["purchasing", "cancel"],
    ["delivered", "cancel"],
  ])("transition_givenOrderAt%s_whenPost%s_then409InvalidAndNoWriteNoEvent", async (from, action) => {
    orderAt(from);

    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/${action}`).expect(409);

    expect(res.body).toMatchObject({ error: "STATE_INVALID_TRANSITION", detail: { from, action } });
    expect(res.body.message).toMatch(/Không chuyển được trạng thái/);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("transition_givenNoUpdateStatusPermission_whenPost_then403AndOrderNotLoaded", async () => {
    currentPerms = ["orders.list", "orders.read"];

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/deposit`).expect(403);

    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it("transition_givenMissingOrder_whenPost_then404", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await request(buildApp()).post(`/api/orders/${ORDER_ID}/deposit`).expect(404, { error: "NOT_FOUND" });
  });

  it("transition_givenConcurrentChange_whenUpdateManyCountZero_then409StateConflictNoHistoryNoEvent", async () => {
    orderAt("quoted");
    tx.order.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/deposit`).expect(409);

    expect(res.body).toMatchObject({ error: "STATE_CONFLICT", detail: { from: "quoted", to: "deposited" } });
    expect(mockAuditTx).not.toHaveBeenCalled();
    expect(logOrder).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(queueCustomerSheetSync).not.toHaveBeenCalled();
  });

  it("transition_givenAuditWriteFailsInsideTx_whenPost_thenRequestFailsAndNoEvent", async () => {
    orderAt("quoted");
    mockAuditTx.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp();
    app.use((_e: any, _req: any, res: any, _next: any) => res.status(500).json({ error: "INTERNAL" }));

    await request(app).post(`/api/orders/${ORDER_ID}/deposit`).expect(500);

    expect(committed).toBe(false);
    expect(mockPublish).not.toHaveBeenCalled();
    expect(logOrder).not.toHaveBeenCalled();
  });

  it("transition_givenUnknownAction_whenPost_thenNoRouteMatches404", async () => {
    await request(buildApp()).post(`/api/orders/${ORDER_ID}/ship-now`).expect(404);
    expect(mockPrisma.order.findUnique).not.toHaveBeenCalled();
  });

  it("transition_givenExistingPayRoute_whenPost_thenNotShadowedByActionRoute", async () => {
    // /:id/pay vẫn tới handler thanh toán (400 vì body thiếu walletId), không phải handler chuyển bước
    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/pay`).send({}).expect(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});

describe("POST /orders/:id/status-correction", () => {
  it("correction_givenAdminAndReason_whenPost_thenAnyStatusSetAuditedWithReason", async () => {
    currentUser = { id: "admin1", roles: ["admin"] };
    orderAt("closed");

    await request(buildApp()).post(`/api/orders/${ORDER_ID}/status-correction`).send({ status: "quoted", reason: "Đóng nhầm đơn" }).expect(200);

    expect(tx.order.updateMany).toHaveBeenCalledWith({ where: { id: ORDER_ID, status: "closed" }, data: { status: "quoted" } });
    expect(mockAuditTx).toHaveBeenCalledWith(tx, expect.objectContaining({
      action: "order.status_corrected", requestId: "req-1",
      before: { status: "closed" }, after: { status: "quoted" }, metadata: { reason: "Đóng nhầm đơn" },
    }));
    expect(mockPublish).toHaveBeenCalledWith(expect.objectContaining({
      eventName: "order.status_changed", metadata: { from: "closed", to: "quoted", correction: true, reason: "Đóng nhầm đơn" },
    }));
  });

  it("correction_givenSuperAdmin_whenPost_thenAllowed", async () => {
    currentUser = { id: "sa", roles: ["super_admin"] };
    orderAt("cancelled");
    await request(buildApp()).post(`/api/orders/${ORDER_ID}/status-correction`).send({ status: "deposited", reason: "Hủy nhầm" }).expect(200);
  });

  it.each([[{ status: "quoted" }], [{ status: "quoted", reason: "abc" }], [{ status: "quoted", reason: "     " }], [{ status: "shipped", reason: "lý do đủ dài" }]])(
    "correction_givenInvalidBody%j_whenPost_then400",
    async (body) => {
      currentUser = { id: "admin1", roles: ["admin"] };
      const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/status-correction`).send(body).expect(400);
      expect(res.body.error).toBe("BAD_REQUEST");
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("correction_givenNonAdminWithUpdateStatus_whenPost_then403", async () => {
    orderAt("closed");
    const res = await request(buildApp()).post(`/api/orders/${ORDER_ID}/status-correction`).send({ status: "quoted", reason: "Đóng nhầm đơn" }).expect(403);
    expect(res.body.error).toBe("FORBIDDEN");
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("GET /orders/:id/transitions", () => {
  it("transitions_givenUpdateStatusPermission_whenGet_thenLabeledActionsAndNoCorrectForStaff", async () => {
    orderAt("deposited");

    const res = await request(buildApp()).get(`/api/orders/${ORDER_ID}/transitions`).expect(200);

    expect(res.body).toEqual({
      status: "deposited",
      actions: [
        { action: "start-purchasing", to: "purchasing", label: "Bắt đầu mua" },
        { action: "cancel", to: "cancelled", label: "Hủy đơn" },
      ],
      canCorrect: false,
    });
  });

  it("transitions_givenNoUpdateStatusPermission_whenGet_thenEmptyActions", async () => {
    currentPerms = ["orders.read"];
    orderAt("quoted");
    const res = await request(buildApp()).get(`/api/orders/${ORDER_ID}/transitions`).expect(200);
    expect(res.body).toEqual({ status: "quoted", actions: [], canCorrect: false });
  });

  it("transitions_givenAdmin_whenGet_thenCanCorrectTrue", async () => {
    currentUser = { id: "admin1", roles: ["admin"] };
    orderAt("closed");
    const res = await request(buildApp()).get(`/api/orders/${ORDER_ID}/transitions`).expect(200);
    expect(res.body).toEqual({ status: "closed", actions: [], canCorrect: true });
  });

  it("transitions_givenMissingOrder_whenGet_then404", async () => {
    mockPrisma.order.findUnique.mockResolvedValue(null);
    await request(buildApp()).get(`/api/orders/${ORDER_ID}/transitions`).expect(404);
  });
});

describe("GET /orders allowedActions", () => {
  it("list_givenUpdateStatusPermission_whenGet_thenEachRowHasAllowedActions", async () => {
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o1", status: "completed" }, { id: "o2", status: "cancelled" }]);

    const res = await request(buildApp()).get("/api/orders").expect(200);

    expect(res.body).toEqual([
      { id: "o1", status: "completed", allowedActions: [{ action: "close", to: "closed", label: "Đóng đơn" }] },
      { id: "o2", status: "cancelled", allowedActions: [] },
    ]);
  });

  it("list_givenNoUpdateStatusPermission_whenGetPaged_thenAllowedActionsEmpty", async () => {
    currentPerms = ["orders.list"];
    mockPrisma.order.findMany.mockResolvedValue([{ id: "o1", status: "quoted" }]);
    mockPrisma.order.count.mockResolvedValue(1);

    const res = await request(buildApp()).get("/api/orders?page=1&pageSize=20").expect(200);

    expect(res.body.items).toEqual([{ id: "o1", status: "quoted", allowedActions: [] }]);
  });
});
