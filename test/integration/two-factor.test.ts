import { generate } from "otplib";
import { config } from "../../src/app/config.js";
import { ADMIN, api, createUser, login, prisma, redis, refreshCookieOf } from "./helpers.js";

// 2FA TOTP end-to-end trên Postgres + Redis thật: setup/enable, login 2 bước, chống dùng lại, recovery, disable, admin reset, policy.

const nowSec = () => Math.floor(Date.now() / 1000);
const usedSteps = new Map<string, Set<number>>();

// Mỗi mã TOTP chỉ dùng được 1 lần/bước -> chọn bước chưa dùng trong cửa sổ ±1 (ưu tiên bước sau để không rơi khỏi cửa sổ).
async function freshCode(secret: string): Promise<string> {
  const used = usedSteps.get(secret) ?? new Set<number>();
  usedSteps.set(secret, used);
  for (const off of [30, 0, -30]) {
    const epoch = nowSec() + off;
    const step = Math.floor(epoch / 30);
    if (!used.has(step)) { used.add(step); return generate({ secret, epoch }); }
  }
  throw new Error("hết mã TOTP chưa dùng trong cửa sổ hiện tại");
}

async function enable2fa(token: string) {
  const setup = await api(token).post("/auth/2fa/setup");
  expect(setup.status).toBe(200);
  const secret = setup.body.secret as string;
  const en = await api(token).post("/auth/2fa/enable", { code: await freshCode(secret) });
  expect(en.status).toBe(200);
  return { secret, recoveryCodes: en.body.recoveryCodes as string[], setup: setup.body };
}

async function challengeFor(email: string, password: string) {
  const res = await api().post("/auth/login", { email, password });
  expect(res.status).toBe(200);
  expect(res.body.twoFactorRequired).toBe(true);
  return res.body.challengeToken as string;
}

describe("2FA TOTP (DB + Redis thật)", () => {
  let adminToken: string;
  beforeAll(async () => { adminToken = (await login()).token; });

  it("setup_enable_storesEncryptedSecretAndHashedRecoveryCodes", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret, recoveryCodes, setup } = await enable2fa(u.token);

    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(recoveryCodes).toHaveLength(10);

    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.totpEnabledAt).toBeTruthy();
    expect(row.totpSecret).toMatch(/^v1:/);
    expect(row.totpSecret).not.toContain(secret);
    const codes = await prisma.userRecoveryCode.findMany({ where: { userId: u.id } });
    expect(codes).toHaveLength(10);
    const raw = recoveryCodes.map((c) => c.replace(/-/g, ""));
    expect(codes.every((c) => !raw.some((r) => c.codeHash.includes(r)))).toBe(true);

    const st = await api(u.token).get("/auth/2fa/status");
    expect(st.body).toMatchObject({ enabled: true, pending: false, recoveryCodesRemaining: 10, required: false });
    expect((await api(u.token).get("/me")).body.twoFactorEnabled).toBe(true);
  });

  it("enable_wrongCode_400_andStillPending", async () => {
    const u = await createUser(adminToken, "viewer");
    await api(u.token).post("/auth/2fa/setup");
    const res = await api(u.token).post("/auth/2fa/enable", { code: "000000" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("TWO_FACTOR_INVALID_CODE");
    expect((await api(u.token).get("/auth/2fa/status")).body).toMatchObject({ enabled: false, pending: true });
    // Chưa enable -> login vẫn 1 bước
    expect((await api().post("/auth/login", { email: u.email, password: u.password })).body.accessToken).toBeTruthy();
  });

  it("login_with2fa_returnsChallengeThenTokensAfterCode", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret } = await enable2fa(u.token);

    const first = await api().post("/auth/login", { email: u.email, password: u.password });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ twoFactorRequired: true, challengeToken: expect.any(String) });
    expect(refreshCookieOf(first)).toBeUndefined();
    const ttlKeys = await redis.keys("2fa:challenge:*");
    const ttls = await Promise.all(ttlKeys.filter((k) => !k.endsWith(":attempts")).map((k) => redis.ttl(k)));
    expect(ttls.every((t) => t > 0 && t <= 300)).toBe(true);

    const second = await api().post("/auth/login/2fa", { challengeToken: first.body.challengeToken, code: await freshCode(secret) });
    expect(second.status).toBe(200);
    expect(second.body.accessToken).toBeTruthy();
    expect(refreshCookieOf(second)).toMatch(/^refresh_token=/);
    expect((await api(second.body.accessToken).get("/me")).status).toBe(200);
    // Refresh cookie từ bước 2 renew được như bình thường
    expect((await api(null, refreshCookieOf(second)).post("/auth/renew")).status).toBe(200);

    // Challenge chỉ dùng 1 lần
    const again = await api().post("/auth/login/2fa", { challengeToken: first.body.challengeToken, code: await freshCode(secret) });
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("TWO_FACTOR_CHALLENGE_INVALID");
  });

  it("login2fa_sameCodeTwiceInWindow_secondRejectedAsReused", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret } = await enable2fa(u.token);
    const code = await freshCode(secret);
    const a = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), code });
    expect(a.status).toBe(200);
    const b = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), code });
    expect(b.status).toBe(401);
    expect(b.body.error).toBe("TWO_FACTOR_CODE_REUSED");
  });

  it("login2fa_fiveWrongCodes_challengeKilledEvenForCorrectCode", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret } = await enable2fa(u.token);
    const ch = await challengeFor(u.email, u.password);
    for (let i = 1; i <= 4; i++) {
      const r = await api().post("/auth/login/2fa", { challengeToken: ch, code: "000000" });
      expect(r.status).toBe(401);
      expect(r.body.detail).toEqual({ attemptsLeft: 5 - i });
    }
    const fifth = await api().post("/auth/login/2fa", { challengeToken: ch, code: "000000" });
    expect(fifth.status).toBe(429);
    expect(fifth.body.error).toBe("TWO_FACTOR_TOO_MANY_ATTEMPTS");
    const sixth = await api().post("/auth/login/2fa", { challengeToken: ch, code: await freshCode(secret) });
    expect(sixth.status).toBe(401);
    expect(sixth.body.error).toBe("TWO_FACTOR_CHALLENGE_INVALID");
  });

  it("login2fa_recoveryCode_worksOnce", async () => {
    const u = await createUser(adminToken, "viewer");
    const { recoveryCodes } = await enable2fa(u.token);
    const ok = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), recoveryCode: recoveryCodes[0].toLowerCase() });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    const reuse = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), recoveryCode: recoveryCodes[0] });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error).toBe("TWO_FACTOR_INVALID_CODE");
    expect((await api(ok.body.accessToken).get("/auth/2fa/status")).body.recoveryCodesRemaining).toBe(9);
  });

  it("regenerateRecoveryCodes_requiresCode_oldCodesStopWorking", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret, recoveryCodes } = await enable2fa(u.token);
    expect((await api(u.token).post("/auth/2fa/recovery-codes", { code: "000000" })).status).toBe(400);
    const res = await api(u.token).post("/auth/2fa/recovery-codes", { code: await freshCode(secret) });
    expect(res.status).toBe(200);
    expect(res.body.recoveryCodes).toHaveLength(10);
    const old = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), recoveryCode: recoveryCodes[1] });
    expect(old.status).toBe(401);
    const fresh = await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), recoveryCode: res.body.recoveryCodes[0] });
    expect(fresh.status).toBe(200);
  });

  it("disable_requiresPasswordAndCode_thenLoginIsSingleStep", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret } = await enable2fa(u.token);
    const badPw = await api(u.token).post("/auth/2fa/disable", { password: "wrong", code: await freshCode(secret) });
    expect(badPw.status).toBe(400);
    expect((await api(u.token).post("/auth/2fa/disable", { password: u.password, code: "000000" })).status).toBe(400);
    const ok = await api(u.token).post("/auth/2fa/disable", { password: u.password, code: await freshCode(secret) });
    expect(ok.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.totpSecret).toBeNull();
    expect(await prisma.userRecoveryCode.count({ where: { userId: u.id } })).toBe(0);
    const res = await api().post("/auth/login", { email: u.email, password: u.password });
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.twoFactorRequired).toBeUndefined();
  });

  it("adminReset_requiresUsersUpdate_clears2fa", async () => {
    const u = await createUser(adminToken, "viewer");
    await enable2fa(u.token);
    const other = await createUser(adminToken, "viewer");
    expect((await api(other.token).post(`/admin/users/${u.id}/2fa/reset`)).status).toBe(403);

    const res = await api(adminToken).post(`/admin/users/${u.id}/2fa/reset`);
    expect(res.status).toBe(200);
    const login1 = await api().post("/auth/login", { email: u.email, password: u.password });
    expect(login1.body.accessToken).toBeTruthy();
    const list = await api(adminToken).get("/admin/users");
    const row = (list.body as { id: string; twoFactorEnabled: boolean; totpSecret?: unknown }[]).find((x) => x.id === u.id)!;
    expect(row.twoFactorEnabled).toBe(false);
    expect(row.totpSecret).toBeUndefined();
    expect(await prisma.accessAudit.count({ where: { action: "auth.2fa.reset_by_admin", targetId: u.id } })).toBe(1);
  });

  it("policy_requiredRole_without2fa_403ExceptMeAndAuth_untilEnabled", async () => {
    const u = await createUser(adminToken, "viewer");
    const prev = config.require2faRoles;
    config.require2faRoles = ["viewer"];
    try {
      const res = await api().post("/auth/login", { email: u.email, password: u.password });
      expect(res.body.accessToken).toBeTruthy();
      expect(res.body.twoFactorSetupRequired).toBe(true);
      const t = res.body.accessToken as string;

      const blocked = await api(t).get("/orders");
      expect(blocked.status).toBe(403);
      expect(blocked.body.error).toBe("TWO_FACTOR_SETUP_REQUIRED");
      const me = await api(t).get("/me");
      expect(me.status).toBe(200);
      expect(me.body.twoFactorSetupRequired).toBe(true);

      const { secret } = await enable2fa(t);
      expect(secret).toBeTruthy();
      expect((await api(t).get("/orders")).body.error).not.toBe("TWO_FACTOR_SETUP_REQUIRED");
      expect((await api(t).get("/me")).body.twoFactorSetupRequired).toBe(false);
      // Admin (không thuộc vai trò bắt buộc) không bị chặn
      expect((await api(adminToken).get("/orders")).status).toBe(200);
    } finally {
      config.require2faRoles = prev;
    }
  });

  it("audit_has2faEventsWithoutSecretsOrCodes", async () => {
    const u = await createUser(adminToken, "viewer");
    const { secret, recoveryCodes } = await enable2fa(u.token);
    await api().post("/auth/login/2fa", { challengeToken: await challengeFor(u.email, u.password), code: "000000" });
    const rows = await prisma.accessAudit.findMany({ where: { actorId: u.id } });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["auth.2fa.setup_started", "auth.2fa.enabled", "auth.login.2fa_challenge", "auth.login.2fa_failed"]));
    const blob = JSON.stringify(rows.map((r) => r.metadata));
    expect(blob).not.toContain(secret);
    expect(blob).not.toContain("000000");
    for (const c of recoveryCodes) expect(blob).not.toContain(c);
  });

  it("adminLogin_unaffectedWhen2faOff", async () => {
    const res = await api().post("/auth/login", ADMIN);
    expect(res.body.accessToken).toBeTruthy();
  });
});
