import crypto from "node:crypto";
import { sha256 } from "./password.js";

const PREFIX = "oak_";

// Scope API key - CHỈ còn dùng cho module /api/ext (MCP, xem modules/ext/), không còn scope nào
// cho route thật (orders.routes.ts...) - route thật chỉ nhận JWT, không nhận API key nữa. Key =
// tag scope (hiển thị lúc tạo key), value = permission thật để kiểm tra user có đủ quyền xin scope
// đó không (xem api-keys.routes.ts).
export const API_KEY_SCOPE_TO_PERMISSION: Record<string, string> = {
  "orders:read": "orders.list",
  "customers:read": "customers.list",
  "trackings:read": "trackings.list",
  "reports:stats": "stats.view",
  "reports:control": "orders.read",
  "reports:warehouse": "warehouse.weigh_vn",
  "reports:admin": "users.list",
  "reports:companycost": "companycost.view",
  "reports:shipments": "shipments.list",
  "reports:accounting": "accounting.reconcile",
};

export const API_KEY_ALLOWED_SCOPES = Object.keys(API_KEY_SCOPE_TO_PERMISSION) as [string, ...string[]];

export function generateApiKey(): { plain: string; prefix: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  const plain = `${PREFIX}${raw}`;
  return { plain, prefix: plain.slice(0, PREFIX.length + 8), hash: sha256(plain) };
}

export function hashApiKey(plain: string): string {
  return sha256(plain);
}
