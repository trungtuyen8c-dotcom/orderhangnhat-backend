import http from "node:http";
import request from "supertest";
import { createApp } from "../../src/app/app.js";
import { prisma } from "../../src/infrastructure/prisma.js";
import { redis } from "../../src/infrastructure/redis.js";
// Giống src/index.ts: đăng ký job handler + subscriber để event -> queue -> worker chạy thật.
import "../../src/modules/backup/backup.jobs.js";
import "../../src/modules/sheets/sheet.jobs.js";
import "../../src/modules/notifications/notification.jobs.js";
import "../../src/modules/notifications/notification.subscribers.js";

export { prisma, redis };

export const ADMIN = { email: "admin@orderhn.local", password: "Admin@12345" };

export const app = createApp();
// 1 server dùng chung cho cả file - request đồng thời đi vào cùng 1 process như production.
export const server = http.createServer(app);

type Method = "get" | "post" | "patch" | "put" | "delete";

export function api(token?: string | null, cookie?: string) {
  const call = (method: Method) => (path: string, body?: unknown) => {
    let r = request(server)[method](`/api${path}`);
    if (token) r = r.set("Authorization", `Bearer ${token}`);
    if (cookie) r = r.set("Cookie", cookie);
    return body === undefined ? r : r.send(body as object);
  };
  return { get: call("get"), post: call("post"), patch: call("patch"), put: call("put"), delete: call("delete") };
}

export const refreshCookieOf = (res: request.Response) => {
  const raw = res.headers["set-cookie"] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith("refresh_token="))?.split(";")[0];
};

export async function login(email = ADMIN.email, password = ADMIN.password) {
  const res = await api().post("/auth/login", { email, password });
  if (res.status !== 200) throw new Error(`login ${email} -> ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.accessToken as string, cookie: refreshCookieOf(res)! };
}

let seq = 0;
export async function createUser(adminToken: string, role: string, password = "Pass@12345") {
  const email = `${role}.${Date.now()}.${++seq}@it.local`;
  const res = await api(adminToken).post("/admin/users", { email, password, fullName: `IT ${role}`, roleKeys: [role] });
  if (res.status !== 201) throw new Error(`createUser ${role} -> ${res.status} ${JSON.stringify(res.body)}`);
  const { token } = await login(email, password);
  return { id: res.body.id as string, email, password, token };
}

export async function createCustomer(token: string, name = `Khach IT ${++seq}`) {
  const res = await api(token).post("/customers", { name });
  if (res.status !== 201 && res.status !== 200) throw new Error(`createCustomer -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string; code: string };
}

export async function createOrder(token: string, customerId: string, items = [{ name: "Ao", unitPriceJpy: 1000, qty: 1 }]) {
  const res = await api(token).post("/orders", { customerId, items, exchangeRate: 180 });
  if (res.status !== 201) throw new Error(`createOrder -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; code: string; status: string };
}

export async function createWallet(token: string, name = `Vi IT ${++seq}`) {
  const res = await api(token).post("/accounting/wallets", { name, currency: "VND", balance: 0 });
  if (res.status !== 201) throw new Error(`createWallet -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}

export async function walletBalance(walletId: string) {
  const w = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
  return Number(w.balance);
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 10_000, stepMs = 150): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`waitFor timeout ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
