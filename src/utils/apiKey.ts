import crypto from "node:crypto";
import { sha256 } from "./password.js";

const PREFIX = "oak_";

// Toàn bộ scope API key có thể xin - chỉ phủ route ĐỌC (GET, không đụng DB ghi). Key = tag scope
// (dùng trong request + hiển thị lúc tạo key), value = permission thật để kiểm tra user có đủ quyền
// xin scope đó không (xem api-keys.routes.ts). Với permission dùng chung cho cả route đọc lẫn route
// ghi (vd. accounting.reconcile, warehouse.weigh_vn), route.ts truyền thêm apiKeyScope riêng cho
// authorize() (xem middlewares/authorize.ts) để API key không bao giờ chạm được route ghi cùng permission.
export const API_KEY_SCOPE_TO_PERMISSION: Record<string, string> = {
  "orders.list": "orders.list",
  "orders.read": "orders.read",
  "customers.list": "customers.list",
  "trackings.list": "trackings.list",
  "shipments.list": "shipments.list",
  "users.list": "users.list",
  "permissions.list": "permissions.list",
  "system.view_audit_log": "system.view_audit_log",
  "companycost.view": "companycost.view",
  "stats.view": "stats.view",
  "accounting.deposits.read": "accounting.reconcile",
  "accounting.wallets.read": "accounting.reconcile",
  "accounting.fund.read": "accounting.reconcile",
  "accounting.reconcile_list.read": "accounting.reconcile",
  "accounting.statement.read": "accounting.reconcile",
  "warehouse.stored.read": "warehouse.weigh_vn",
  "warehouse.history.read": "warehouse.weigh_vn",
  "warehouse.recon.read": "warehouse.weigh_vn",
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
