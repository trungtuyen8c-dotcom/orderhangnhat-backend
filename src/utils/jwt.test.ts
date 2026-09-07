import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { signAccess, verifyAccess } from "./jwt.js";
import { config } from "../config.js";

const payload = { user_id: "u1", token_version: 1, jti: "j1" };

describe("signAccess / verifyAccess", () => {
  it("verifyAccess_tokenFromSignAccess_returnsOriginalPayload", () => {
    const token = signAccess(payload);
    const decoded = verifyAccess(token);
    expect(decoded.user_id).toBe("u1");
    expect(decoded.token_version).toBe(1);
    expect(decoded.jti).toBe("j1");
  });

  it("verifyAccess_tamperedToken_throws", () => {
    const token = signAccess(payload);
    const tampered = token.slice(0, -2) + (token.slice(-2) === "aa" ? "bb" : "aa");
    expect(() => verifyAccess(tampered)).toThrow();
  });

  it("verifyAccess_tokenSignedWithWrongSecret_throws", () => {
    const token = jwt.sign(payload, "some-other-secret", { expiresIn: 900 });
    expect(() => verifyAccess(token)).toThrow();
  });

  it("verifyAccess_expiredToken_throws", () => {
    const token = jwt.sign(payload, config.jwtSecret, { expiresIn: -10 });
    expect(() => verifyAccess(token)).toThrow(/expired/i);
  });
});
