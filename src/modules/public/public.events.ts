import type { Request, Response } from "express";
import type { BusinessEvent, BusinessEventName } from "../../app/events/businessEvents.js";
import { eventBus } from "../../app/events/EventBus.js";
import { logError } from "../../infrastructure/systemLog.js";
import { getPublicOrderById, orderIdOfTracking } from "./public.service.js";

// SSE cho trang tra cứu công khai /tra-cuu/:token. Đẩy lại ĐÚNG payload whitelist của GET /public/orders/:token
// khi đơn (hoặc tracking của đơn) đổi. Bus in-process -> chỉ thấy event phát trong process API; thay đổi từ
// worker riêng/process khác được bắt bởi lần kiểm tra lại định kỳ cùng nhịp heartbeat.

export const ORDER_EVENTS: BusinessEventName[] = ["order.updated", "order.status_changed", "order.deleted"];
export const TRACKING_EVENTS: BusinessEventName[] = ["tracking.updated", "tracking.assigned"];

export const SSE_LIMITS = {
  heartbeatMs: 25_000,
  maxAgeMs: 30 * 60_000,
  maxPerIp: 5,
  maxTotal: 1000,
  debounceMs: 300,
  retryMs: 10_000,
};

export interface SseClient {
  orderId: string;
  ip: string;
  last?: string;
  push(event: string, data: string): void;
  close(): void;
}

type HubDeps = {
  load: (orderId: string) => Promise<unknown | null>;
  orderOfTracking: (trackingId: string) => Promise<string | null>;
  maxPerIp: number;
  maxTotal: number;
  debounceMs: number;
};

type Bus = { on(name: BusinessEventName, h: (e: BusinessEvent) => void | Promise<void>): void };

export class PublicOrderHub {
  private byOrder = new Map<string, Set<SseClient>>();
  private perIp = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private total = 0;

  constructor(private deps: HubDeps) {}

  get size() { return this.total; }
  connectionsOf(ip: string) { return this.perIp.get(ip) ?? 0; }

  // Đồng bộ (không await) để kiểm tra cap + đăng ký là 1 bước, không race giữa các request song song.
  tryAdd(c: SseClient): boolean {
    if (this.total >= this.deps.maxTotal || this.connectionsOf(c.ip) >= this.deps.maxPerIp) return false;
    let set = this.byOrder.get(c.orderId);
    if (!set) { set = new Set(); this.byOrder.set(c.orderId, set); }
    set.add(c);
    this.perIp.set(c.ip, this.connectionsOf(c.ip) + 1);
    this.total++;
    return true;
  }

  remove(c: SseClient) {
    const set = this.byOrder.get(c.orderId);
    if (!set?.delete(c)) return;
    if (!set.size) {
      this.byOrder.delete(c.orderId);
      const t = this.timers.get(c.orderId);
      if (t) { clearTimeout(t); this.timers.delete(c.orderId); }
    }
    const n = this.connectionsOf(c.ip) - 1;
    if (n > 0) this.perIp.set(c.ip, n); else this.perIp.delete(c.ip);
    this.total--;
  }

  async onEvent(e: BusinessEvent) {
    if (!this.total) return;
    let orderId: string | null = null;
    if (e.entityType === "order") orderId = e.entityId;
    else if (e.entityType === "tracking") {
      const fromMeta = e.metadata?.orderId;
      orderId = typeof fromMeta === "string" ? fromMeta : await this.deps.orderOfTracking(e.entityId);
    }
    if (orderId) this.schedule(orderId);
  }

  // Gom các event dồn dập của cùng 1 đơn (sửa nhiều tracking 1 lúc) thành 1 lần đọc DB.
  schedule(orderId: string) {
    if (!this.byOrder.has(orderId) || this.timers.has(orderId)) return;
    this.timers.set(orderId, setTimeout(() => {
      this.timers.delete(orderId);
      void this.flush(orderId);
    }, this.deps.debounceMs));
  }

  async flush(orderId: string) {
    const set = this.byOrder.get(orderId);
    if (!set?.size) return;
    let data: unknown;
    try { data = await this.deps.load(orderId); }
    catch (err) { logError({ order_id: orderId, err: (err as Error).message }, "public_sse_load_failed"); return; }
    for (const c of [...set]) {
      if (!data) { c.push("gone", "{}"); c.close(); continue; }
      const json = JSON.stringify(data);
      if (json === c.last) continue;
      c.last = json;
      c.push("order", json);
    }
  }

  subscribe(bus: Bus) {
    for (const name of [...ORDER_EVENTS, ...TRACKING_EVENTS]) bus.on(name, (e) => this.onEvent(e));
  }
}

export const publicOrderHub = new PublicOrderHub({
  load: getPublicOrderById,
  orderOfTracking: orderIdOfTracking,
  maxPerIp: SSE_LIMITS.maxPerIp,
  maxTotal: SSE_LIMITS.maxTotal,
  debounceMs: SSE_LIMITS.debounceMs,
});
publicOrderHub.subscribe(eventBus);

type StreamOpts = { hub: PublicOrderHub; orderId: string; initial: unknown; heartbeatMs?: number; maxAgeMs?: number; retryMs?: number };

// Trả false khi vượt cap (caller trả 429, chưa ghi header nào).
export function openOrderStream(req: Request, res: Response, opts: StreamOpts): boolean {
  const { hub, orderId } = opts;
  const heartbeatMs = opts.heartbeatMs ?? SSE_LIMITS.heartbeatMs;
  const maxAgeMs = opts.maxAgeMs ?? SSE_LIMITS.maxAgeMs;
  let closed = false;
  const client: SseClient = {
    orderId,
    // X-Real-IP do nginx ghi đè = $remote_addr; req.ip (trust proxy=true) lấy XFF trái nhất, client tự giả được.
    ip: req.header?.("x-real-ip") ?? req.ip ?? req.socket.remoteAddress ?? "unknown",
    push: (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${data}\n\n`); },
    close: () => cleanup(true),
  };
  if (!hub.tryAdd(client)) return false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write(`retry: ${opts.retryMs ?? SSE_LIMITS.retryMs}\n\n`);
  client.last = JSON.stringify(opts.initial);
  client.push("order", client.last);

  const heartbeat = setInterval(() => {
    if (closed) return;
    res.write(": ping\n\n");
    hub.schedule(orderId);
  }, heartbeatMs);
  // Hết hạn: báo client rồi đóng; EventSource tự nối lại (retry) -> phiên mới, giữ kết nối treo không quá lâu.
  const maxAge = setTimeout(() => { client.push("bye", "{}"); cleanup(true); }, maxAgeMs);

  function cleanup(end: boolean) {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxAge);
    hub.remove(client);
    if (end) res.end();
  }
  // res (không phải req): từ Node 16 req 'close' bắn ngay khi đọc xong body GET, không chờ client ngắt.
  res.on("close", () => cleanup(false));
  return true;
}
