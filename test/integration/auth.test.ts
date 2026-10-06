import { ADMIN, api, createUser, login, redis, refreshCookieOf } from "./helpers.js";

describe("auth: login / renew / logout / blacklist (DB + Redis thật)", () => {
  it("login_validCredentials_returnsAccessTokenAndRefreshCookie", async () => {
    const res = await api().post("/auth/login", ADMIN);
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(refreshCookieOf(res)).toMatch(/^refresh_token=/);
    const me = await api(res.body.accessToken).get("/me");
    expect(me.status).toBe(200);
    expect(me.body.roles).toContain("super_admin");
  });

  it("login_wrongPassword_401InvalidCredentials", async () => {
    const res = await api().post("/auth/login", { ...ADMIN, password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("INVALID_CREDENTIALS");
  });

  it("login_invalidBody_400", async () => {
    const res = await api().post("/auth/login", { email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("protectedRoute_noToken_401", async () => {
    const res = await api().get("/me");
    expect(res.status).toBe(401);
  });

  it("renew_validCookie_rotatesTokens", async () => {
    const s = await login();
    const res = await api(null, s.cookie).post("/auth/renew");
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    const next = refreshCookieOf(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(s.cookie);
    expect((await api(res.body.accessToken).get("/me")).status).toBe(200);
  });

  it("renew_noCookie_401NoRefresh", async () => {
    const res = await api().post("/auth/renew");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("NO_REFRESH");
  });

  it("renew_reusedRefreshToken_401TokenReuseAndAllSessionsRevoked", async () => {
    // Given: user riêng để không làm chết phiên admin của các test khác
    const { token: adminToken } = await login();
    const u = await createUser(adminToken, "viewer");
    const s = await login(u.email, u.password);
    const first = await api(null, s.cookie).post("/auth/renew");
    expect(first.status).toBe(200);
    // When: gửi lại refresh token đã dùng
    const reuse = await api(null, s.cookie).post("/auth/renew");
    // Then: bị coi là đánh cắp -> 401 + mọi phiên (kể cả token mới) chết
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe("TOKEN_REUSE");
    expect((await api(first.body.accessToken).get("/me")).status).toBe(401);
    expect((await api(null, refreshCookieOf(first)).post("/auth/renew")).status).toBe(401);
  });

  it("logout_blacklistsJtiInRedis_andAccessTokenRejected", async () => {
    const s = await login();
    const out = await api(s.token, s.cookie).post("/auth/logout");
    expect(out.status).toBe(200);
    const keys = await redis.keys("revoked_jti:*");
    expect(keys.length).toBeGreaterThanOrEqual(1);
    const me = await api(s.token).get("/me");
    expect(me.status).toBe(401);
    expect(me.body.error).toBe("REVOKED");
    // refresh token của phiên đó cũng bị xoá
    expect((await api(null, s.cookie).post("/auth/renew")).status).toBe(401);
  });

  it("logoutAll_otherSessionsOfSameUserDie", async () => {
    const { token: adminToken } = await login();
    const u = await createUser(adminToken, "viewer");
    const a = await login(u.email, u.password);
    const b = await login(u.email, u.password);
    expect((await api(a.token).post("/auth/logout-all")).status).toBe(200);
    expect((await api(b.token).get("/me")).status).toBe(401);
    expect((await api(null, b.cookie).post("/auth/renew")).status).toBe(401);
  });

  it("deactivatedUser_cannotLoginAndExistingTokenRejected", async () => {
    const { token: adminToken } = await login();
    const u = await createUser(adminToken, "viewer");
    expect((await api(adminToken).patch(`/admin/users/${u.id}`, { isActive: false })).status).toBe(200);
    expect((await api(u.token).get("/me")).status).toBe(401);
    expect((await api().post("/auth/login", { email: u.email, password: u.password })).status).toBe(401);
  });
});
