import { describe, it, expect, beforeEach } from "vitest";
import { InAppNotificationService, NOTIF_MAX_PER_KEY, NOTIF_TTL_SECONDS, type NotificationStore } from "./notification.service.js";

function fakeStore() {
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const ttl = new Map<string, number>();
  const store: NotificationStore = {
    async lpush(k, ...v) { lists.set(k, [...v.reverse(), ...(lists.get(k) ?? [])]); },
    async ltrim(k, s, e) { lists.set(k, (lists.get(k) ?? []).slice(s, e + 1)); },
    async lrange(k, s, e) { return (lists.get(k) ?? []).slice(s, e + 1); },
    async sadd(k, ...m) { const set = sets.get(k) ?? new Set(); m.forEach((x) => set.add(x)); sets.set(k, set); },
    async smembers(k) { return [...(sets.get(k) ?? [])]; },
    async expire(k, s) { ttl.set(k, s); },
  };
  return { store, lists, sets, ttl };
}

describe("InAppNotificationService", () => {
  let f: ReturnType<typeof fakeStore>;
  let svc: InAppNotificationService;
  beforeEach(() => { f = fakeStore(); svc = new InAppNotificationService(f.store); });

  it("notify_rolesAndUsers_storesItemPerRecipientKeyWithTtl", async () => {
    // When
    await svc.notify({ id: "n1", recipients: { roles: ["accountant"], userIds: ["u2"] }, type: "deposit.created", title: "T" });
    // Then
    expect(f.lists.get("notif:role:accountant")).toHaveLength(1);
    expect(f.lists.get("notif:user:u2")).toHaveLength(1);
    expect(f.ttl.get("notif:role:accountant")).toBe(NOTIF_TTL_SECONDS);
    expect(JSON.parse(f.lists.get("notif:user:u2")![0])).toMatchObject({ id: "n1", type: "deposit.created", title: "T", body: null });
  });

  it("notify_noRecipients_writesNothing", async () => {
    await svc.notify({ recipients: {}, type: "x", title: "T" });
    expect(f.lists.size).toBe(0);
  });

  it("notify_overCap_keepsOnlyNewestMaxItems", async () => {
    for (let i = 0; i < NOTIF_MAX_PER_KEY + 5; i++) await svc.notify({ id: `n${i}`, recipients: { roles: ["r"] }, type: "x", title: "T" });
    const l = f.lists.get("notif:role:r")!;
    expect(l).toHaveLength(NOTIF_MAX_PER_KEY);
    expect(JSON.parse(l[0]).id).toBe(`n${NOTIF_MAX_PER_KEY + 4}`);
  });

  it("list_userAndRoleKeys_mergesDedupesHidesOwnActionsNewestFirst", async () => {
    // Given: n1 gửi cả role lẫn user (trùng id), n2 do chính user tạo, n3 mới nhất
    const push = (k: string, o: object) => f.store.lpush(k, JSON.stringify(o));
    await push("notif:role:accountant", { id: "n1", actorId: "x", createdAt: "2026-10-01T00:00:00Z", title: "a" });
    await push("notif:user:u1", { id: "n1", actorId: "x", createdAt: "2026-10-01T00:00:00Z", title: "a" });
    await push("notif:role:accountant", { id: "n2", actorId: "u1", createdAt: "2026-10-02T00:00:00Z", title: "b" });
    await push("notif:role:accountant", { id: "n3", actorId: null, createdAt: "2026-10-03T00:00:00Z", title: "c" });
    await f.store.lpush("notif:role:accountant", "not-json");
    // When
    const r = await svc.list({ id: "u1", roles: ["accountant"] });
    // Then
    expect(r.items.map((i) => i.id)).toEqual(["n3", "n1"]);
    expect(r.unread).toBe(2);
    expect(r.items.every((i) => i.read === false)).toBe(true);
  });

  it("list_roleNotHeld_doesNotSeeThatRolesNotifications", async () => {
    await svc.notify({ id: "n1", recipients: { roles: ["accountant"] }, type: "x", title: "T" });
    expect((await svc.list({ id: "u9", roles: ["sale"] })).items).toEqual([]);
  });

  it("markRead_specificIds_marksOnlyThoseAndUnreadDrops", async () => {
    await svc.notify({ id: "n1", recipients: { userIds: ["u1"] }, type: "x", title: "A" });
    await svc.notify({ id: "n2", recipients: { userIds: ["u1"] }, type: "x", title: "B" });
    const res = await svc.markRead({ id: "u1", roles: [] }, ["n1", "n1"]);
    expect(res).toEqual({ marked: 1 });
    const r = await svc.list({ id: "u1", roles: [] });
    expect(r.unread).toBe(1);
    expect(r.items.find((i) => i.id === "n1")!.read).toBe(true);
    expect(f.ttl.get("notif:read:u1")).toBe(NOTIF_TTL_SECONDS);
  });

  it("markRead_noIds_marksAllVisible", async () => {
    await svc.notify({ id: "n1", recipients: { roles: ["r"] }, type: "x", title: "A" });
    await svc.notify({ id: "n2", recipients: { userIds: ["u1"] }, type: "x", title: "B" });
    expect(await svc.markRead({ id: "u1", roles: ["r"] })).toEqual({ marked: 2 });
    expect((await svc.list({ id: "u1", roles: ["r"] })).unread).toBe(0);
  });

  it("markRead_nothingVisible_returnsZeroWithoutWriting", async () => {
    expect(await svc.markRead({ id: "u1", roles: [] })).toEqual({ marked: 0 });
    expect(f.sets.size).toBe(0);
  });
});
