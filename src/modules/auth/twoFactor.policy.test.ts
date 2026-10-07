import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { isExemptPath, isTwoFactorRequired, needsTwoFactorSetup, enforceTwoFactorPolicy } from "./twoFactor.policy.js";

describe("twoFactor.policy", () => {
  it("isTwoFactorRequired_emptyPolicy_falseForEveryone", () => {
    expect(isTwoFactorRequired(["super_admin"], [])).toBe(false);
  });

  it("isTwoFactorRequired_userHasListedRole_true", () => {
    expect(isTwoFactorRequired(["staff", "accountant"], ["super_admin", "accountant"])).toBe(true);
    expect(isTwoFactorRequired(["staff"], ["super_admin"])).toBe(false);
  });

  it("needsTwoFactorSetup_alreadyEnabled_false", () => {
    expect(needsTwoFactorSetup({ totpEnabledAt: new Date() }, ["super_admin"], ["super_admin"])).toBe(false);
    expect(needsTwoFactorSetup({ totpEnabledAt: null }, ["super_admin"], ["super_admin"])).toBe(true);
  });

  it.each([
    ["/api/me", true], ["/api/me?x=1", true], ["/api/auth/2fa/setup", true], ["/api/auth/logout", true],
    ["/api/me/notifications", false], ["/api/orders", false], ["/api/authx", false], ["/api/admin/users", false],
  ])("isExemptPath(%s) = %s", (url, exempt) => {
    expect(isExemptPath(url)).toBe(exempt);
  });

  it("enforceTwoFactorPolicy_defaultEmptyEnv_neverThrows", () => {
    const req = { originalUrl: "/api/orders" } as Request;
    expect(() => enforceTwoFactorPolicy(req, { totpEnabledAt: null }, ["super_admin"])).not.toThrow();
  });
});
