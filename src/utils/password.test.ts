import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, sha256 } from "./password.js";

describe("sha256", () => {
  it("sha256_knownInput_returnsDeterministicHexDigest", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("sha256_sameInputTwice_returnsSameHash", () => {
    expect(sha256("token-123")).toBe(sha256("token-123"));
  });
});

describe("hashPassword / verifyPassword", () => {
  it("verifyPassword_hashOfSamePassword_returnsTrue", async () => {
    const hash = await hashPassword("s3cret!");
    await expect(verifyPassword("s3cret!", hash)).resolves.toBe(true);
  });

  it("verifyPassword_wrongPassword_returnsFalse", async () => {
    const hash = await hashPassword("s3cret!");
    await expect(verifyPassword("wrong-pass", hash)).resolves.toBe(false);
  });

  it("hashPassword_sameInputTwice_producesDifferentHashes", async () => {
    const [h1, h2] = await Promise.all([hashPassword("s3cret!"), hashPassword("s3cret!")]);
    expect(h1).not.toBe(h2);
  });
});
