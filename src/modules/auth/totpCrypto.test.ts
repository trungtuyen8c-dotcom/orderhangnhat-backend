import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { decryptSecret, encryptSecret, parseKey, resolveKey } from "./totpCrypto.js";

const KEY = crypto.randomBytes(32);

describe("totpCrypto", () => {
  it("encryptDecrypt_roundTrip_returnsOriginalAndNeverStoresPlaintext", () => {
    const enc = encryptSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", KEY);
    expect(enc.startsWith("v1:")).toBe(true);
    expect(enc).not.toContain("JBSWY3DP");
    expect(decryptSecret(enc, KEY)).toBe("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP");
  });

  it("encrypt_sameInputTwice_differentCiphertext", () => {
    expect(encryptSecret("S", KEY)).not.toBe(encryptSecret("S", KEY));
  });

  it("decrypt_wrongKey_throwsNotConfigured", () => {
    const enc = encryptSecret("S", KEY);
    expect(() => decryptSecret(enc, crypto.randomBytes(32))).toThrow(expect.objectContaining({ code: "TWO_FACTOR_NOT_CONFIGURED" }));
  });

  it("decrypt_tamperedCiphertext_throws", () => {
    const [v, iv, tag, ct] = encryptSecret("SECRET", KEY).split(":");
    const bad = Buffer.from(ct, "base64"); bad[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, bad.toString("base64")].join(":"), KEY)).toThrow();
  });

  it("decrypt_plaintextValue_throwsInsteadOfReturningIt", () => {
    expect(() => decryptSecret("JBSWY3DPEHPK3PXP", KEY)).toThrow(expect.objectContaining({ code: "TWO_FACTOR_NOT_CONFIGURED" }));
  });

  it("parseKey_acceptsBase64AndHex32Bytes_rejectsOthers", () => {
    expect(parseKey(KEY.toString("base64"))?.equals(KEY)).toBe(true);
    expect(parseKey(KEY.toString("hex"))?.equals(KEY)).toBe(true);
    expect(parseKey("short")).toBeNull();
    expect(parseKey(crypto.randomBytes(16).toString("base64"))).toBeNull();
  });

  it("resolveKey_productionWithoutKey_throws503NotConfigured", () => {
    expect(() => resolveKey({ raw: "", isProd: true })).toThrow(expect.objectContaining({ code: "TWO_FACTOR_NOT_CONFIGURED", status: 503 }));
  });

  it("resolveKey_invalidKey_throwsEvenInDev", () => {
    expect(() => resolveKey({ raw: "abc", isProd: false })).toThrow(expect.objectContaining({ code: "TWO_FACTOR_NOT_CONFIGURED" }));
  });

  it("resolveKey_devWithoutKey_derives32ByteKeyDeterministically", () => {
    const a = resolveKey({ raw: "", isProd: false, devSeed: "s" });
    expect(a.length).toBe(32);
    expect(a.equals(resolveKey({ raw: "", isProd: false, devSeed: "s" }))).toBe(true);
  });
});
