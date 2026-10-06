import request from "supertest";
import { api, createUser, login, prisma, server } from "./helpers.js";

const ext = (key: string | null, path: string, header: "bearer" | "x-api-key" = "bearer") => {
  let r = request(server).get(`/api/ext${path}`);
  if (key) r = header === "bearer" ? r.set("Authorization", `Bearer ${key}`) : r.set("X-API-Key", key);
  return r;
};

async function newKey(token: string, scopes: string[], extra: Record<string, unknown> = {}) {
  const r = await api(token).post("/api-keys", { name: `it-${Date.now()}-${Math.random()}`, scopes, ...extra });
  if (r.status !== 201) throw new Error(`create key -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; key: string };
}

describe("ext API key gating (/api/ext)", () => {
  let admin: string;
  beforeAll(async () => { admin = (await login()).token; });

  it("validKey_withScope_200_bothHeaderStyles", async () => {
    const k = await newKey(admin, ["orders:read"]);
    expect((await ext(k.key, "/me")).status).toBe(200);
    expect((await ext(k.key, "/orders")).status).toBe(200);
    expect((await ext(k.key, "/orders", "x-api-key")).status).toBe(200);
  });

  it("missingOrUnknownKey_401", async () => {
    expect((await ext(null, "/me")).status).toBe(401);
    expect((await ext("oak_khong_ton_tai", "/me")).status).toBe(401);
  });

  it("missingScope_403", async () => {
    const k = await newKey(admin, ["orders:read"]);
    const r = await ext(k.key, "/customers");
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("FORBIDDEN");
  });

  it("revokedKey_401", async () => {
    const k = await newKey(admin, ["orders:read"]);
    expect((await api(admin).delete(`/api-keys/${k.id}`)).status).toBe(200);
    expect((await ext(k.key, "/orders")).status).toBe(401);
  });

  it("expiredKey_401", async () => {
    const k = await newKey(admin, ["orders:read"], { expiresInDays: 1 });
    await prisma.apiKey.update({ where: { id: k.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ext(k.key, "/orders")).status).toBe(401);
  });

  it("ownerDeactivated_401", async () => {
    const u = await createUser(admin, "viewer");
    const k = await newKey(u.token, ["orders:read"]);
    expect((await ext(k.key, "/orders")).status).toBe(200);
    expect((await api(admin).patch(`/admin/users/${u.id}`, { isActive: false })).status).toBe(200);
    expect((await ext(k.key, "/orders")).status).toBe(401);
  });

  it("createKey_scopeBeyondUserPermissions_403", async () => {
    const u = await createUser(admin, "viewer");
    const r = await api(u.token).post("/api-keys", { name: "over", scopes: ["reports:accounting"] });
    expect(r.status).toBe(403);
  });

  it("apiKey_cannotCallMainApi_401", async () => {
    const k = await newKey(admin, ["orders:read"]);
    expect((await api(k.key).post("/api-keys", { name: "x", scopes: ["orders:read"] })).status).toBe(401);
  });

  it("rateLimit_exceeded_429", async () => {
    const k = await newKey(admin, ["orders:read"], { rateLimit: 3 });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await ext(k.key, "/me")).status);
    expect(codes).toEqual([200, 200, 200, 429]);
  });
});
