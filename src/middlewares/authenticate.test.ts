import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db.js", () => ({
  prisma: { user: { findUnique: vi.fn() }, apiKey: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("../redis.js", () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("../utils/jwt.js", () => ({
  verifyAccess: vi.fn(),
}));

import { authenticate, authenticateApiKey, authenticateEither } from "./authenticate.js";
import { prisma } from "../db.js";
import { redis } from "../redis.js";
import { verifyAccess } from "../utils/jwt.js";

const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn> };
  apiKey: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
};
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

describe("authenticateApiKey middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticateApiKey_noXApiKeyHeader_returns401", async () => {
    const req: any = { headers: {} };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["not found", null],
    ["revoked", { id: "k1", revokedAt: new Date(), expiresAt: null, scopes: [], user: { isActive: true, id: "u1", tokenVersion: 1, roles: [] } }],
    ["expired", { id: "k1", revokedAt: null, expiresAt: new Date(Date.now() - 1000), scopes: [], user: { isActive: true, id: "u1", tokenVersion: 1, roles: [] } }],
  ])("authenticateApiKey_keyIs %s_returns401InvalidApiKey", async (_label, record) => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(record);
    const req: any = { headers: { "x-api-key": "oak_test" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "INVALID_API_KEY" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticateApiKey_userInactive_returns401Unauthorized", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1", revokedAt: null, expiresAt: null, scopes: ["orders.list"],
      user: { id: "u1", isActive: false, tokenVersion: 1, roles: [] },
    });
    const req: any = { headers: { "x-api-key": "oak_test" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateApiKey(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "UNAUTHORIZED" });
    expect(next).not.toHaveBeenCalled();
  });

  it("authenticateApiKey_validKey_setsReqUserAndApiKeyScopesAndCallsNext", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue({
      id: "k1", revokedAt: null, expiresAt: null, scopes: ["orders.list", "customers.list"],
      user: { id: "u1", isActive: true, tokenVersion: 2, roles: [{ role: { key: "sale" } }] },
    });
    mockPrisma.apiKey.update.mockResolvedValue({});
    const req: any = { headers: { "x-api-key": "oak_test" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateApiKey(req, res, next);
    expect(req.user).toEqual(expect.objectContaining({ id: "u1", tokenVersion: 2, jti: "apikey:k1", roles: ["sale"] }));
    expect(req.apiKeyScopes).toEqual(["orders.list", "customers.list"]);
    expect(next).toHaveBeenCalled();
  });
});

describe("authenticateEither middleware", () => {
  beforeEach(() => vi.clearAllMocks());

  it("authenticateEither_xApiKeyHeaderPresent_routesToApiKeyPath", async () => {
    mockPrisma.apiKey.findUnique.mockResolvedValue(null);
    const req: any = { headers: { "x-api-key": "oak_bad" } };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateEither(req, res, next);
    // Lỗi đặc trưng của nhánh API key (INVALID_API_KEY), không phải nhánh JWT (UNAUTHORIZED) -> chứng minh đúng route.
    expect(res.json).toHaveBeenCalledWith({ error: "INVALID_API_KEY" });
  });

  it("authenticateEither_noXApiKeyHeader_routesToJwtPath", async () => {
    const req: any = { headers: {} };
    const res = fakeRes();
    const next = vi.fn();
    await authenticateEither(req, res, next);
    expect(res.json).toHaveBeenCalledWith({ error: "UNAUTHORIZED" });
  });
});
