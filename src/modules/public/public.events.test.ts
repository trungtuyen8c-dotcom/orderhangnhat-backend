import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { BusinessEvent } from "../../app/events/businessEvents.js";
import { openOrderStream, PublicOrderHub, type SseClient } from "./public.events.js";

const ev = (over: Partial<BusinessEvent>): BusinessEvent => ({
  eventId: "e1", eventName: "order.status_changed", occurredAt: new Date().toISOString(), actorId: "u1",
  entityType: "order", entityId: "o1", ...over,
});

function makeHub(over: Partial<ConstructorParameters<typeof PublicOrderHub>[0]> = {}) {
  const load = vi.fn(async (_id: string): Promise<unknown> => ({ code: "JA1", status: "purchasing" }));
  const orderOfTracking = vi.fn(async (_id: string): Promise<string | null> => "o1");
  const hub = new PublicOrderHub({ load, orderOfTracking, maxPerIp: 2, maxTotal: 3, debounceMs: 50, ...over });
  return { hub, load, orderOfTracking };
}

function client(orderId = "o1", ip = "1.1.1.1"): SseClient & { events: [string, string][] } {
  const events: [string, string][] = [];
  return { orderId, ip, events, push: (e, d) => events.push([e, d]), close: vi.fn() };
}

describe("PublicOrderHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tryAdd_overPerIpCap_rejectsThirdFromSameIpButAcceptsOtherIp", () => {
    const { hub } = makeHub();
    expect(hub.tryAdd(client())).toBe(true);
    expect(hub.tryAdd(client())).toBe(true);
    expect(hub.tryAdd(client())).toBe(false);
    expect(hub.tryAdd(client("o1", "2.2.2.2"))).toBe(true);
    expect(hub.size).toBe(3);
  });

  it("tryAdd_overTotalCap_rejects", () => {
    const { hub } = makeHub({ maxPerIp: 10, maxTotal: 1 });
    expect(hub.tryAdd(client())).toBe(true);
    expect(hub.tryAdd(client("o2", "9.9.9.9"))).toBe(false);
  });

  it("remove_calledTwice_freesSlotOnce", () => {
    const { hub } = makeHub();
    const c = client();
    hub.tryAdd(c);
    hub.remove(c);
    hub.remove(c);
    expect(hub.size).toBe(0);
    expect(hub.connectionsOf("1.1.1.1")).toBe(0);
  });

  it("onEvent_burstForSameOrder_loadsOnceAndPushesChangedPayload", async () => {
    const { hub, load } = makeHub();
    const c = client();
    c.last = JSON.stringify({ code: "JA1", status: "quoted" });
    hub.tryAdd(c);
    await hub.onEvent(ev({}));
    await hub.onEvent(ev({ eventName: "order.updated" }));
    await vi.advanceTimersByTimeAsync(60);
    expect(load).toHaveBeenCalledTimes(1);
    expect(c.events).toEqual([["order", JSON.stringify({ code: "JA1", status: "purchasing" })]]);
  });

  it("flush_payloadUnchanged_pushesNothing", async () => {
    const { hub } = makeHub();
    const c = client();
    c.last = JSON.stringify({ code: "JA1", status: "purchasing" });
    hub.tryAdd(c);
    await hub.flush("o1");
    expect(c.events).toEqual([]);
  });

  it("onEvent_otherOrderOrNoSubscribers_doesNotLoad", async () => {
    const { hub, load } = makeHub();
    await hub.onEvent(ev({}));
    hub.tryAdd(client("o2"));
    await hub.onEvent(ev({ entityId: "o1" }));
    await vi.advanceTimersByTimeAsync(60);
    expect(load).not.toHaveBeenCalled();
  });

  it("onEvent_trackingWithoutOrderMeta_resolvesOrderViaLookup", async () => {
    const { hub, load, orderOfTracking } = makeHub();
    hub.tryAdd(client());
    await hub.onEvent(ev({ eventName: "tracking.updated", entityType: "tracking", entityId: "t1" }));
    await vi.advanceTimersByTimeAsync(60);
    expect(orderOfTracking).toHaveBeenCalledWith("t1");
    expect(load).toHaveBeenCalledWith("o1");
  });

  it("onEvent_trackingAssignedWithOrderMeta_skipsLookup", async () => {
    const { hub, orderOfTracking, load } = makeHub();
    hub.tryAdd(client("o9"));
    await hub.onEvent(ev({ eventName: "tracking.assigned", entityType: "tracking", entityId: "t1", metadata: { orderId: "o9" } }));
    await vi.advanceTimersByTimeAsync(60);
    expect(orderOfTracking).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith("o9");
  });

  it("flush_orderDeleted_sendsGoneAndCloses", async () => {
    const { hub } = makeHub({ load: vi.fn(async () => null) });
    const c = client();
    hub.tryAdd(c);
    await hub.flush("o1");
    expect(c.events).toEqual([["gone", "{}"]]);
    expect(c.close).toHaveBeenCalled();
  });

  it("flush_loadThrows_keepsClientsAndPushesNothing", async () => {
    const { hub } = makeHub({ load: vi.fn(async () => { throw new Error("db down"); }) });
    const c = client();
    hub.tryAdd(c);
    await hub.flush("o1");
    expect(c.events).toEqual([]);
    expect(hub.size).toBe(1);
  });
});

function fakeReqRes(ip = "1.1.1.1") {
  const req = { ip, socket: {} } as unknown as Request;
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    chunks: [] as string[],
    headers: {} as Record<string, string>,
    ended: false,
    writeHead(_s: number, h: Record<string, string>) { this.headers = h; return this; },
    flushHeaders() {},
    write(chunk: string) { this.chunks.push(chunk); return true; },
    end() { this.ended = true; emitter.emit("close"); },
  });
  return { req, res: res as unknown as Response & typeof res };
}

describe("openOrderStream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("open_setsSseHeadersAndSendsInitialPayload", () => {
    const { hub } = makeHub();
    const { req, res } = fakeReqRes();
    expect(openOrderStream(req, res, { hub, orderId: "o1", initial: { code: "JA1" } })).toBe(true);
    expect(res.headers["Content-Type"]).toContain("text/event-stream");
    expect(res.headers["X-Accel-Buffering"]).toBe("no");
    expect(res.headers["Cache-Control"]).toContain("no-cache");
    expect(res.chunks.join("")).toContain(`event: order\ndata: {"code":"JA1"}\n\n`);
  });

  it("heartbeat_everyInterval_writesCommentPing", () => {
    const { hub } = makeHub();
    const { req, res } = fakeReqRes();
    openOrderStream(req, res, { hub, orderId: "o1", initial: {}, heartbeatMs: 1000 });
    vi.advanceTimersByTime(2100);
    expect(res.chunks.filter((c) => c === ": ping\n\n")).toHaveLength(2);
  });

  it("maxAge_reached_sendsByeEndsAndFreesSlot", () => {
    const { hub } = makeHub();
    const { req, res } = fakeReqRes();
    openOrderStream(req, res, { hub, orderId: "o1", initial: {}, heartbeatMs: 1000, maxAgeMs: 5000 });
    vi.advanceTimersByTime(5001);
    expect(res.chunks.join("")).toContain("event: bye");
    expect(res.ended).toBe(true);
    expect(hub.size).toBe(0);
  });

  it("clientDisconnect_freesSlotAndStopsHeartbeat", () => {
    const { hub } = makeHub();
    const { req, res } = fakeReqRes();
    openOrderStream(req, res, { hub, orderId: "o1", initial: {}, heartbeatMs: 1000 });
    res.emit("close");
    const n = res.chunks.length;
    vi.advanceTimersByTime(3000);
    expect(hub.size).toBe(0);
    expect(res.chunks.length).toBe(n);
  });

  it("overCap_returnsFalseWithoutWritingHeaders", () => {
    const { hub } = makeHub({ maxPerIp: 1 });
    openOrderStream(fakeReqRes().req, fakeReqRes().res, { hub, orderId: "o1", initial: {} });
    const { req, res } = fakeReqRes();
    expect(openOrderStream(req, res, { hub, orderId: "o1", initial: {} })).toBe(false);
    expect(res.chunks).toEqual([]);
  });
});
