import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { user: { findUnique: vi.fn() } },
}));
vi.mock("../redis.js", () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../utils/jwt.js", () => ({
  verifyAccess: vi.fn(),
}));

import { authenticate } from "./authenticate.js";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { verifyAccess } from "../utils/jwt.js";

const mockPrisma = prisma as unknown as { user: { findUnique: ReturnType<typeof vi.fn> } };
const mockRedis = redis as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
const mockVerifyAccess = verifyAccess as unknown as ReturnType<typeof vi.fn>;

function fakeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("authenticate middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticate_noAuthorizationHeader_returns401Unauthorized", async () => {
    const req: any = { headers: {} };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_headerNotBearerScheme_returns401Unauthorized", async () => {
    const req: any = { headers: { authorization: "Basic abc123" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_verifyAccessThrowsTokenExpiredError_returns401TokenExpired", async () => {
    mockVerifyAccess.mockImplementation(() => {
      const e: any = new Error("jwt expired");
      e.name = "TokenExpiredError";
      throw e;
    });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "TOKEN_EXPIRED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_verifyAccessThrowsOtherError_returns401InvalidToken", async () => {
    mockVerifyAccess.mockImplementation(() => {
      throw new Error("invalid signature");
    });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "INVALID_TOKEN" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_jtiRevokedInRedis_returns401Revoked", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue("1");
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(mockRedis.get).toHaveBeenCalledWith("revoked_jti:j1");
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "REVOKED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_userNotFound_returns401Unauthorized", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_userInactive_returns401Unauthorized", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: false, tokenVersion: 1, roles: [] });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_tokenVersionMismatch_returns401Unauthorized", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: true, tokenVersion: 2, roles: [] });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticate_validTokenActiveUser_setsReqUserWithRolesAndCallsNext", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      id: "u1", isActive: true, tokenVersion: 1,
      roles: [{ role: { key: "staff" } }, { role: { key: "sale" } }],
    });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(req.user).toEqual({ id: "u1", tokenVersion: 1, jti: "j1", exp: 9999999999, roles: ["staff", "sale"] });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("authenticate_validToken_marksUserOnlineInRedisWith90sTtl", async () => {
    mockVerifyAccess.mockReturnValue({ user_id: "u1", token_version: 1, jti: "j1", exp: 9999999999 });
    mockRedis.get.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: true, tokenVersion: 1, roles: [] });
    const req: any = { headers: { authorization: "Bearer sometoken" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticate(req, res, next);
    expect(mockRedis.set).toHaveBeenCalledWith("online:u1", "1", "EX", 90);
  });
});
