import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generate, generateSecret } from "otplib";

vi.mock("../../infrastructure/prisma.js", () => {
  const p: any = { user: { count: vi.fn() } };
  p.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(p));
  return { prisma: p };
});
vi.mock("../../app/audit.js", () => ({ logAudit: vi.fn(), logOrder: vi.fn() }));
vi.mock("./twoFactor.repository.js", () => ({
  findUser: vi.fn(), setPendingSecret: vi.fn(), markEnabled: vi.fn(), clearTotp: vi.fn(),
  replaceRecoveryCodes: vi.fn(), consumeRecoveryCode: vi.fn(), countUnusedRecoveryCodes: vi.fn(),
}));
vi.mock("./password.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password.js")>();
  return { ...actual, verifyPassword: vi.fn() };
});

import { redis } from "../../infrastructure/redis.js";
import { logAudit } from "../../app/audit.js";
import * as repo from "./twoFactor.repository.js";
import { verifyPassword } from "./password.js";
import { encryptSecret } from "./totpCrypto.js";
import * as svc from "./twoFactor.service.js";

// Redis giả trong bộ nhớ đủ cho get/set NX/incr/expire/del.
const store = new Map<string, string>();
const r = redis as any;
r.get = vi.fn(async (k: string) => store.get(k) ?? null);
r.set = vi.fn(async (k: string, v: string, ...args: unknown[]) => {
  if (args.includes("NX") && store.has(k)) return null;
  store.set(k, v); return "OK";
});
r.incr = vi.fn(async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; });
r.expire = vi.fn(async () => 1);
r.del = vi.fn(async (k: string) => (store.delete(k) ? 1 : 0));

const m = <T>(f: T) => f as unknown as ReturnType<typeof vi.fn>;
const SECRET = generateSecret();
const enabledUser = (over: Record<string, unknown> = {}) => ({
  id: "u1", email: "a@b.c", isActive: true, passwordHash: "h", tokenVersion: 0, roles: [],
  totpSecret: encryptSecret(SECRET), totpEnabledAt: new Date(), ...over,
});
const ctx = { ip: "1.2.3.4", requestId: "rid" };

beforeEach(() => { store.clear(); vi.clearAllMocks(); });

describe("recovery codes", () => {
  it("generateRecoveryCode_format4x4Base32_unique", () => {
    const codes = Array.from({ length: 50 }, svc.generateRecoveryCode);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(new Set(codes).size).toBe(50);
  });

  it("hashRecoveryCode_ignoresCaseSpacesAndDashes", () => {
    expect(svc.hashRecoveryCode("abcd-efgh-ijkl-mnop")).toBe(svc.hashRecoveryCode(" ABCDEFGH IJKLMNOP "));
    expect(svc.hashRecoveryCode("ABCD-EFGH-IJKL-MNOP")).not.toContain("ABCD");
  });
});

describe("verifyTotp", () => {
  // Cố định giữa 1 bước 30s -> không phụ thuộc thời điểm chạy test (không lệch qua ranh giới bước).
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1_800_000_015_000); });
  afterEach(() => vi.useRealTimers());

  it("verifyTotp_currentCode_okThenReusedSameWindow", async () => {
    const code = await generate({ secret: SECRET });
    const enc = encryptSecret(SECRET);
    expect(await svc.verifyTotp("u1", enc, code)).toBe("ok");
    expect(await svc.verifyTotp("u1", enc, code)).toBe("reused");
  });

  it("verifyTotp_previousStepWithinTolerance_ok", async () => {
    const code = await generate({ secret: SECRET, epoch: Math.floor(Date.now() / 1000) - 30 });
    expect(await svc.verifyTotp("u1", encryptSecret(SECRET), code)).toBe("ok");
  });

  it("verifyTotp_twoStepsOld_invalid", async () => {
    const code = await generate({ secret: SECRET, epoch: Math.floor(Date.now() / 1000) - 90 });
    expect(await svc.verifyTotp("u1", encryptSecret(SECRET), code)).toBe("invalid");
  });

  it("verifyTotp_nonNumeric_invalidWithoutCrash", async () => {
    expect(await svc.verifyTotp("u1", encryptSecret(SECRET), "abcdef")).toBe("invalid");
  });
});

describe("setup / enable", () => {
  it("setup_returnsOtpauthUriAndPngQr_storesEncryptedPendingSecret", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null, totpSecret: null }));
    const out = await svc.setup("u1", ctx);
    expect(out.otpauthUri).toMatch(/^otpauth:\/\/totp\/.+secret=/);
    expect(out.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const stored = m(repo.setPendingSecret).mock.calls[0][1] as string;
    expect(stored.startsWith("v1:")).toBe(true);
    expect(stored).not.toContain(out.secret);
    expect(JSON.stringify(m(logAudit).mock.calls)).not.toContain(out.secret);
  });

  it("setup_alreadyEnabled_409", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    await expect(svc.setup("u1", ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_ALREADY_ENABLED", status: 409 });
  });

  it("enable_validCode_returns10RecoveryCodesAndStoresOnlyHashes", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null }));
    const { recoveryCodes } = await svc.enable("u1", await generate({ secret: SECRET }), ctx);
    expect(recoveryCodes).toHaveLength(10);
    const hashes = m(repo.replaceRecoveryCodes).mock.calls[0][2] as string[];
    expect(hashes).toEqual(recoveryCodes.map(svc.hashRecoveryCode));
    expect(repo.markEnabled).toHaveBeenCalled();
  });

  it("enable_wrongCode_400InvalidAndCountsFail", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null }));
    await expect(svc.enable("u1", "000000", ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_INVALID_CODE", status: 400 });
    expect(store.get("2fa:fails:u1")).toBe("1");
  });

  it("enable_noPendingSecret_409NotPending", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null, totpSecret: null }));
    await expect(svc.enable("u1", "123456", ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_NOT_PENDING" });
  });

  it("enable_userLockedAfterTooManyFails_429", async () => {
    store.set("2fa:fails:u1", String(svc.MAX_USER_FAILS));
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null }));
    await expect(svc.enable("u1", await generate({ secret: SECRET }), ctx)).rejects.toMatchObject({ status: 429 });
  });
});

describe("disable / regenerate", () => {
  it("disable_wrongPassword_400AndKeeps2fa", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    m(verifyPassword).mockResolvedValue(false);
    await expect(svc.disable("u1", "x", "123456", ctx)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 400 });
    expect(repo.clearTotp).not.toHaveBeenCalled();
  });

  it("disable_passwordAndRecoveryCode_clears", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    m(verifyPassword).mockResolvedValue(true);
    m(repo.consumeRecoveryCode).mockResolvedValue(true);
    await svc.disable("u1", "pw", "ABCD-EFGH-IJKL-MNOP", ctx);
    expect(repo.consumeRecoveryCode).toHaveBeenCalledWith("u1", svc.hashRecoveryCode("ABCDEFGHIJKLMNOP"));
    expect(repo.clearTotp).toHaveBeenCalled();
  });

  it("regenerate_notEnabled_409", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null }));
    await expect(svc.regenerateRecoveryCodes("u1", "123456", ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_NOT_ENABLED" });
  });
});

describe("challenge", () => {
  it("completeChallenge_validCode_returnsUserAndChallengeSingleUse", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    const token = await svc.createChallenge("u1");
    const out = await svc.completeChallenge(token, { code: await generate({ secret: SECRET }) }, ctx);
    expect(out.user.id).toBe("u1");
    expect(out.method).toBe("totp");
    await expect(svc.completeChallenge(token, { code: "123456" }, ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_CHALLENGE_INVALID" });
  });

  it("completeChallenge_fiveWrongCodes_challengeDestroyedEvenForCorrectSixth", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    const token = await svc.createChallenge("u1");
    for (let i = 1; i <= 4; i++) {
      await expect(svc.completeChallenge(token, { code: "000000" }, ctx))
        .rejects.toMatchObject({ code: "TWO_FACTOR_INVALID_CODE", status: 401, detail: { attemptsLeft: 5 - i } });
    }
    await expect(svc.completeChallenge(token, { code: "000000" }, ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_TOO_MANY_ATTEMPTS", status: 429 });
    await expect(svc.completeChallenge(token, { code: await generate({ secret: SECRET }) }, ctx))
      .rejects.toMatchObject({ code: "TWO_FACTOR_CHALLENGE_INVALID" });
  });

  it("completeChallenge_userDisabled2faMeanwhile_invalid", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ totpEnabledAt: null, totpSecret: null }));
    const token = await svc.createChallenge("u1");
    await expect(svc.completeChallenge(token, { code: "123456" }, ctx)).rejects.toMatchObject({ code: "TWO_FACTOR_CHALLENGE_INVALID" });
  });

  it("completeChallenge_auditHasNoCodeOrSecret", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    const token = await svc.createChallenge("u1");
    await svc.completeChallenge(token, { code: "000000" }, ctx).catch(() => undefined);
    const audit = JSON.stringify(m(logAudit).mock.calls);
    expect(audit).not.toContain("000000");
    expect(audit).not.toContain(SECRET);
    expect(audit).not.toContain(token);
  });
});

describe("adminReset", () => {
  it("adminReset_nonSuperResetsSuperAdmin_403Protected", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser({ roles: [{ role: { key: "super_admin" } }] }));
    await expect(svc.adminReset("u1", { id: "a", roles: ["manager"] })).rejects.toMatchObject({ code: "PROTECTED" });
    expect(repo.clearTotp).not.toHaveBeenCalled();
  });

  it("adminReset_ok_clearsAndAudits", async () => {
    m(repo.findUser).mockResolvedValue(enabledUser());
    await svc.adminReset("u1", { id: "a", roles: ["super_admin"] });
    expect(repo.clearTotp).toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.2fa.reset_by_admin", targetId: "u1" }));
  });
});
