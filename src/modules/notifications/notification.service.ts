import { randomUUID } from "crypto";
import { redis } from "../../infrastructure/redis.js";

// Người nhận đã resolve: theo role key (mọi user có role đó thấy) hoặc theo user id.
export type NotificationRecipients = { roles?: string[]; userIds?: string[] };

export type NotificationInput = {
  id?: string; // id ổn định (vd eventId) -> job retry ghi lại không tạo bản trùng khi đọc
  recipients: NotificationRecipients;
  type: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  actorId?: string | null;
};

// Business service KHÔNG gọi trực tiếp: chỉ publish event -> notification.subscribers -> job notification.send.
// Thêm kênh (Email/LINE) = thêm implementation, không đổi nơi phát.
export interface NotificationService {
  notify(input: NotificationInput): Promise<void>;
}

export type StoredNotification = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  actorId: string | null;
  createdAt: string;
};

export type NotificationView = StoredNotification & { read: boolean };

// Tập lệnh Redis tối thiểu dùng ở đây (để test thay bằng fake in-memory).
export type NotificationStore = {
  lpush(key: string, ...values: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, seconds: number): Promise<unknown>;
};

export const NOTIF_MAX_PER_KEY = 100;
export const NOTIF_TTL_SECONDS = 30 * 24 * 3600;
const roleKey = (r: string) => `notif:role:${r}`;
const userKey = (id: string) => `notif:user:${id}`;
const readKey = (id: string) => `notif:read:${id}`;

export type Viewer = { id: string; roles: string[] };

export class InAppNotificationService implements NotificationService {
  constructor(private store: NotificationStore = redis as unknown as NotificationStore) {}

  async notify(input: NotificationInput): Promise<void> {
    const keys = [...new Set([...(input.recipients.roles ?? []).map(roleKey), ...(input.recipients.userIds ?? []).map(userKey)])];
    if (!keys.length) return;
    const item: StoredNotification = {
      id: input.id ?? randomUUID(),
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      actorId: input.actorId ?? null,
      createdAt: new Date().toISOString(),
    };
    const json = JSON.stringify(item);
    for (const k of keys) {
      await this.store.lpush(k, json);
      await this.store.ltrim(k, 0, NOTIF_MAX_PER_KEY - 1);
      await this.store.expire(k, NOTIF_TTL_SECONDS);
    }
  }

  // Gộp thông báo theo user + mọi role của user, bỏ trùng id, bỏ thông báo do chính user gây ra, mới nhất trước.
  private async collect(viewer: Viewer): Promise<StoredNotification[]> {
    const keys = [userKey(viewer.id), ...viewer.roles.map(roleKey)];
    const lists = await Promise.all(keys.map((k) => this.store.lrange(k, 0, NOTIF_MAX_PER_KEY - 1)));
    const byId = new Map<string, StoredNotification>();
    for (const raw of lists.flat()) {
      let n: StoredNotification;
      try { n = JSON.parse(raw); } catch { continue; }
      if (!n?.id || byId.has(n.id) || (n.actorId && n.actorId === viewer.id)) continue;
      byId.set(n.id, n);
    }
    return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async list(viewer: Viewer, limit = 50): Promise<{ items: NotificationView[]; unread: number }> {
    const [all, readIds] = await Promise.all([this.collect(viewer), this.store.smembers(readKey(viewer.id))]);
    const read = new Set(readIds);
    const views = all.map((n) => ({ ...n, read: read.has(n.id) }));
    return { items: views.slice(0, limit), unread: views.filter((v) => !v.read).length };
  }

  // ids rỗng/không truyền = đánh dấu đã đọc toàn bộ đang thấy.
  async markRead(viewer: Viewer, ids?: string[]): Promise<{ marked: number }> {
    const target = ids?.length ? [...new Set(ids)] : (await this.collect(viewer)).map((n) => n.id);
    if (!target.length) return { marked: 0 };
    await this.store.sadd(readKey(viewer.id), ...target);
    await this.store.expire(readKey(viewer.id), NOTIF_TTL_SECONDS);
    return { marked: target.length };
  }
}

export const inAppNotifications = new InAppNotificationService();
