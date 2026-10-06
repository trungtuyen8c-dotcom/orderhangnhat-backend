import http from "node:http";
import type { AddressInfo } from "node:net";
import { api, createCustomer, createOrder, login, prisma, server, waitFor } from "./helpers.js";

type SseEvent = { event: string; data: string };
type Stream = { status: number; headers: http.IncomingHttpHeaders; events: SseEvent[]; body: string; close(): void };

// Mở 1 kết nối SSE thật (supertest đệm cả body nên không dùng được cho stream).
function openSse(path: string): Promise<Stream> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/api${path}`, headers: { Accept: "text/event-stream" } }, (res) => {
      const s: Stream = { status: res.statusCode!, headers: res.headers, events: [], body: "", close: () => req.destroy() };
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        s.body += chunk;
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data !== undefined) s.events.push({ event: ev, data });
        }
      });
      res.on("error", () => undefined);
      resolve(s);
    });
    req.on("error", (e) => (e.message.includes("socket hang up") ? undefined : reject(e)));
  });
}

const lastOrder = (s: Stream) => {
  const e = [...s.events].reverse().find((x) => x.event === "order");
  return e ? (JSON.parse(e.data) as { status: string; code: string }) : null;
};

describe("public order SSE (M11-1, API + DB thật)", () => {
  let admin: string;
  let order: { id: string; code: string };
  let token: string;
  const streams: Stream[] = [];

  beforeAll(async () => {
    admin = (await login()).token;
    const c = await createCustomer(admin);
    order = await createOrder(admin, c.id);
    token = (await prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { publicToken: true } })).publicToken;
  });

  afterEach(() => { while (streams.length) streams.pop()!.close(); });

  it("events_unknownToken_404Json", async () => {
    const r = await api().get("/public/orders/khong-ton-tai/events");
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("NOT_FOUND");
  });

  it("events_open_sseHeadersAndInitialPublicSafePayload", async () => {
    const s = await openSse(`/public/orders/${token}/events`);
    streams.push(s);
    expect(s.status).toBe(200);
    expect(s.headers["content-type"]).toContain("text/event-stream");
    expect(s.headers["x-accel-buffering"]).toBe("no");
    const first = await waitFor(async () => lastOrder(s));
    expect(first.code).toBe(order.code);
    const rest = (await api().get(`/public/orders/${token}`)).body;
    expect(JSON.parse(s.events[0].data)).toEqual(rest);
    // whitelist: không có giá/ví/tỉ giá
    expect(Object.keys(rest).sort()).toEqual(["code", "createdAt", "customer", "items", "status", "trackings"]);
    expect(Object.keys(rest.items[0]).sort()).toEqual(["name", "qty"]);
    expect(s.body).not.toMatch(/price|totalVnd|exchangeRate|wallet/i);
  });

  it("events_orderStatusChanges_pushesNewPayload", async () => {
    const s = await openSse(`/public/orders/${token}/events`);
    streams.push(s);
    await waitFor(async () => lastOrder(s));
    const before = lastOrder(s)!.status;
    const r = await api(admin).post(`/orders/${order.id}/start-purchasing`);
    expect(r.status).toBe(200);
    const pushed = await waitFor(async () => (lastOrder(s)?.status === "purchasing" ? lastOrder(s) : null), 5000);
    expect(before).not.toBe("purchasing");
    expect(pushed.status).toBe("purchasing");
  });

  it("events_overPerIpCap_429ThenFreedAfterDisconnect", async () => {
    for (let i = 0; i < 5; i++) {
      const s = await openSse(`/public/orders/${token}/events`);
      expect(s.status).toBe(200);
      streams.push(s);
    }
    const over = await api().get(`/public/orders/${token}/events`);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("RATE_LIMITED");

    streams.pop()!.close();
    const again = await waitFor(async () => {
      const s = await openSse(`/public/orders/${token}/events`);
      if (s.status === 200) return s;
      s.close();
      return null;
    }, 5000);
    streams.push(again);
  });
});
