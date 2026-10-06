import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

vi.mock("../../middlewares/authenticate.js", () => ({
  authenticate: (req: any, _res: any, next: any) => { req.user = { id: "u1", roles: ["accountant"] }; next(); },
}));
vi.mock("../../infrastructure/prisma.js", () => ({ prisma: {} }));
vi.mock("../notifications/notification.service.js", () => ({
  inAppNotifications: { list: vi.fn(), markRead: vi.fn() },
}));

import { meRouter } from "./me.routes.js";
import { inAppNotifications } from "../notifications/notification.service.js";

const svc = inAppNotifications as any;
const app = () => { const a = express(); a.use(express.json()); a.use("/api/me", meRouter); return a; };

describe("me notification routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getNotifications_defaultLimit_listsForCurrentUserAndRoles", async () => {
    svc.list.mockResolvedValue({ items: [], unread: 0 });
    const res = await request(app()).get("/api/me/notifications");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unread: 0 });
    expect(svc.list).toHaveBeenCalledWith({ id: "u1", roles: ["accountant"] }, 50);
  });

  it("getNotifications_limitOutOfRange_returns400", async () => {
    const res = await request(app()).get("/api/me/notifications?limit=1000");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
    expect(svc.list).not.toHaveBeenCalled();
  });

  it("postRead_withIds_marksThose", async () => {
    svc.markRead.mockResolvedValue({ marked: 2 });
    const res = await request(app()).post("/api/me/notifications/read").send({ ids: ["n1", "n2"] });
    expect(res.body).toEqual({ marked: 2 });
    expect(svc.markRead).toHaveBeenCalledWith({ id: "u1", roles: ["accountant"] }, ["n1", "n2"]);
  });

  it("postRead_noBody_marksAll", async () => {
    svc.markRead.mockResolvedValue({ marked: 0 });
    await request(app()).post("/api/me/notifications/read");
    expect(svc.markRead).toHaveBeenCalledWith({ id: "u1", roles: ["accountant"] }, undefined);
  });
});
