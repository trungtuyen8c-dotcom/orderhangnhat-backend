import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../../db.js", () => ({
  prisma: {
    user: { findUnique: vi.fn(), update: vi.fn() },
    refreshToken: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}));
vi.mock("../../utils/audit.js", () => ({ logAudit: vi.fn(), logOrder: vi.fn() }));
vi.mock("../../utils/password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/password.js")>();
  return { ...actual, verifyPassword: vi.fn(), hashPassword: vi.fn() };
});

import { authRouter } from "./auth.routes.js";
import { prisma } from "../../db.js";
import { redis } from "../../redis.js";
import { logAudit } from "../../utils/audit.js";
import { verifyPassword } from "../../utils/password.js";
import { signAccess } from "../../utils/jwt.js";

const mockPrisma = prisma as unknown as {
  user: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  refreshToken: {
    findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn>;
  };
};
const mockRedis = redis as unknown as { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> };
const mockLogAudit = logAudit as ReturnType<typeof vi.fn>;
const mockVerifyPassword = verifyPassword as ReturnType<typeof vi.fn>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/auth", authRouter);
  return app;
}

// Lấy giá trị cookie refresh_token từ header Set-Cookie của response login/renew.
function extractRefreshCookie(res: request.Response): string {
  const setCookie = (res.headers["set-cookie"] ?? []) as unknown as string[];
  const line = setCookie.find((c) => c.startsWith("refresh_token="));
  if (!line) throw new Error("no refresh_token cookie in response");
  return line.split(";")[0];
}

describe("POST /api/auth/login", () => {
  beforeEach(() => vi.clearAllMocks());

  it("login_invalidBody_returns400BadRequest", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "BAD_REQUEST" });
  });

  it("login_userNotFound_returns401AndLogsFailedAttempt", async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "a@b.com", password: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_CREDENTIALS" });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login.failed" }));
  });

  it("login_wrongPassword_returns401InvalidCredentials", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: true, passwordHash: "hash", tokenVersion: 0 });
    mockVerifyPassword.mockResolvedValue(false);
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "a@b.com", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("login_inactiveUser_returns401EvenWithCorrectPassword", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: false, passwordHash: "hash", tokenVersion: 0 });
    mockVerifyPassword.mockResolvedValue(true);
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "a@b.com", password: "right" });
    expect(res.status).toBe(401);
  });

  it("login_validCredentials_returnsAccessTokenSetsRefreshCookieAndCreatesRefreshRow", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: true, passwordHash: "hash", tokenVersion: 0 });
    mockVerifyPassword.mockResolvedValue(true);
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "a@b.com", password: "right" });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(extractRefreshCookie(res)).toMatch(/^refresh_token=.+/);
    expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u1", used: false }) }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login.success", actorId: "u1" }));
  });
});

describe("POST /api/auth/renew", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renew_noRefreshCookie_returns401NoRefresh", async () => {
    const res = await request(buildApp()).post("/api/auth/renew");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "NO_REFRESH" });
  });

  it("renew_cookieMatchesNoRow_returns401InvalidRefresh", async () => {
    mockPrisma.refreshToken.findFirst.mockResolvedValue(null);
    const res = await request(buildApp()).post("/api/auth/renew").set("Cookie", "refresh_token=bogus-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_REFRESH" });
  });

  it("renew_rowExpired_returns401InvalidRefresh", async () => {
    mockPrisma.refreshToken.findFirst.mockResolvedValue({
      id: "rt1", userId: "u1", used: false, expiresAt: new Date(Date.now() - 1000),
    });
    const res = await request(buildApp()).post("/api/auth/renew").set("Cookie", "refresh_token=expired-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_REFRESH" });
  });

  // Trọng tâm: phát hiện refresh token bị dùng lại (đã dùng 1 lần rồi mà còn gửi lên nữa) -> nghi bị đánh cắp.
  it("renew_tokenAlreadyUsed_detectsReuseRevokesAllTokensAndBumpsTokenVersion", async () => {
    mockPrisma.refreshToken.findFirst.mockResolvedValue({
      id: "rt1", userId: "u1", used: true, expiresAt: new Date(Date.now() + 100000),
    });
    const res = await request(buildApp()).post("/api/auth/renew").set("Cookie", "refresh_token=stolen-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "TOKEN_REUSE" });
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { userId: "u1" } });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({ where: { id: "u1" }, data: { tokenVersion: { increment: 1 } } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.refresh.reuse_detected", actorId: "u1" }));
    // Reuse bị chặn hẳn -> không được cấp token mới dưới bất kỳ hình thức nào.
    expect(mockPrisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it("renew_validUnusedToken_marksOldTokenUsedAndIssuesNewAccessAndRefreshTokens", async () => {
    mockPrisma.refreshToken.findFirst.mockResolvedValue({
      id: "rt1", userId: "u1", used: false, expiresAt: new Date(Date.now() + 100000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: true, tokenVersion: 0 });
    const res = await request(buildApp()).post("/api/auth/renew").set("Cookie", "refresh_token=valid-token");
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: "rt1" }, data: { used: true } });
    expect(mockPrisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: "u1", used: false }) }),
    );
    const newCookie = extractRefreshCookie(res);
    expect(newCookie).not.toBe("refresh_token=valid-token");
  });

  it("renew_validTokenButUserDeactivatedSinceIssue_marksUsedThenReturns401Unauthorized", async () => {
    mockPrisma.refreshToken.findFirst.mockResolvedValue({
      id: "rt1", userId: "u1", used: false, expiresAt: new Date(Date.now() + 100000),
    });
    mockPrisma.user.findUnique.mockResolvedValue({ id: "u1", isActive: false, tokenVersion: 0 });
    const res = await request(buildApp()).post("/api/auth/renew").set("Cookie", "refresh_token=valid-token");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "UNAUTHORIZED" });
    // Token cũ vẫn phải bị đánh dấu used dù user hết hiệu lực - không để lại token còn "sống" tái dùng được.
    expect(mockPrisma.refreshToken.update).toHaveBeenCalledWith({ where: { id: "rt1" }, data: { used: true } });
  });
});

describe("POST /api/auth/logout", () => {
  beforeEach(() => vi.clearAllMocks());

  function validAccessToken(user: { id: string; tokenVersion: number; roles?: { role: { key: string } }[] }) {
    mockPrisma.user.findUnique.mockResolvedValue({ id: user.id, isActive: true, tokenVersion: user.tokenVersion, roles: user.roles ?? [] });
    mockRedis.get.mockResolvedValue(null);
    return signAccess({ user_id: user.id, token_version: user.tokenVersion, jti: "jti-1" });
  }

  it("logout_noAuthorizationHeader_returns401AndDoesNotTouchRefreshTokenOrRedis", async () => {
    const res = await request(buildApp()).post("/api/auth/logout");
    expect(res.status).toBe(401);
    expect(mockPrisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it("logout_validAccessToken_revokesJtiInRedisAndDeletesMatchingRefreshTokenAndClearsCookie", async () => {
    const token = validAccessToken({ id: "u1", tokenVersion: 0 });
    const res = await request(buildApp())
      .post("/api/auth/logout")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", "refresh_token=my-refresh-value");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockRedis.set).toHaveBeenCalledWith("revoked_jti:jti-1", "1", "EX", expect.any(Number));
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { tokenHash: expect.any(String) } });
    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.logout", actorId: "u1" }));
    const setCookie = (res.headers["set-cookie"] ?? []) as unknown as string[];
    expect(setCookie.some((c) => c.startsWith("refresh_token=;"))).toBe(true);
  });

  it("logout_noRefreshCookiePresent_stillRevokesJtiButSkipsRefreshTokenDeletion", async () => {
    const token = validAccessToken({ id: "u1", tokenVersion: 0 });
    const res = await request(buildApp()).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(mockRedis.set).toHaveBeenCalled();
    expect(mockPrisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });
});
