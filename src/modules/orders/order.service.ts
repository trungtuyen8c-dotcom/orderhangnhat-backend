import { v4 as uuid } from "uuid";
import type { Order, OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit, logOrder } from "../../app/audit.js";
import { LegacyError } from "../../app/http/legacyError.js";
import { paged, type PageParams } from "../../app/http/pagination.js";
import { eventBus } from "../../app/events/EventBus.js";
import type { BusinessEventName } from "../../app/events/businessEvents.js";
import { detectMarketplace } from "../../integrations/marketplace/scrape.js";
import { applyOrderCardCharges, reverseOrderCardCharges } from "../accounting/orderCard.js";
import { reversePaymentWallets } from "../accounting/wallet.service.js";
import { claimOrCreateTracking } from "../tracking/tracking.repository.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { recomputeOrderTotals } from "./order.totals.js";
import { assertTransition, INITIAL_STATUS, isEditable } from "./order.state.js";
import * as repo from "./order.repository.js";
import {
  isPayLater, PRICING_FIELDS,
  type ConsignmentInput, type CreateOrderInput, type EditOrderInput,
} from "./order.validation.js";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; roles: string[]; requestId?: string };

const notFound = () => new LegacyError(404, "NOT_FOUND");

function publish(eventName: BusinessEventName, actor: Actor, orderId: string, metadata?: Record<string, unknown>) {
  eventBus.publish({ eventName, actorId: actor.id, entityType: "order", entityId: orderId, metadata });
}

const audit = (actor: Actor, orderId: string, action: string, metadata?: Record<string, unknown>) =>
  logAudit({ actorId: actor.id, targetId: orderId, action, metadata, requestId: actor.requestId, entity: "order" });

// Chặn dán nhầm link Yahoo vào đơn Mercari và ngược lại (source phải khớp domain link món hàng)
export function findWrongMarketplaceUrl(source: string, items: { url?: string }[]): string | null {
  if (source !== "yahoo" && source !== "mercari") return null;
  for (const i of items) {
    if (!i.url) continue;
    const detected = detectMarketplace(i.url);
    if (detected && detected !== source) return i.url;
  }
  return null;
}

function assertMarketplaceMatches(source: string, items: { url?: string }[]) {
  const wrongUrl = findWrongMarketplaceUrl(source, items);
  if (wrongUrl) throw new LegacyError(400, "WRONG_MARKETPLACE", `Link không khớp: ${wrongUrl}`);
}

// Tạo đơn với mã JA tăng dần; trùng mã do tạo đồng thời (P2002) -> chạy lại cả transaction (tối đa 5 lần).
async function createWithNextCode<T>(run: (tx: Tx, code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => run(tx, await repo.nextOrderCode(tx)));
    } catch (e: any) {
      if (e?.code === "P2002" && attempt < 5) continue;
      throw e;
    }
  }
}

// ---- Queries ----

export function buildListWhere(source: string, exclude: string): { where: Prisma.OrderWhereInput | undefined; payLater: boolean } {
  const excludeList = exclude.split(",").map((s) => s.trim()).filter(Boolean);
  const payLater = isPayLater(source);
  const where = payLater ? { source } : excludeList.length ? { source: { notIn: excludeList } } : undefined;
  return { where, payLater };
}

// Không có `page` -> trả mảng như cũ; có `page` -> { items, pagination }.
export async function listOrders(q: { source: string; exclude: string }, page: PageParams | null) {
  const { where, payLater } = buildListWhere(q.source, q.exclude);
  const r = await repo.listOrders(where, payLater, page);
  return page ? paged(r.rows, r.total!, page) : r.rows;
}

export async function listFixRequests() {
  const orders = await repo.listFixRequests();
  return orders.map((o) => ({ id: o.id, code: o.code, fixRequest: o.fixRequest, customer: o.customer?.name ?? null }));
}

export async function lookupCode(code: string) {
  if (!code) return { order: null };
  const o = await repo.findByCodeInsensitive(code);
  return { order: o ? { id: o.id, code: o.code, customerName: o.customer.name } : null };
}

export const checkDuplicate = (url: string, code: string, excludeOrderId: string) => repo.findDuplicateOrderCodes(url, code, excludeOrderId);

export async function getOrderDetail(id: string) {
  const r = await repo.findDetail(id);
  if (!r) throw notFound();
  const { order, debt, documents, trackingLogs } = r;
  const logs = order.logs.map((l) => ({ ...l, id: l.id.toString() }));
  return { ...order, logs, trackingLogs: trackingLogs.map((l) => ({ ...l, id: l.id.toString() })), debt, documents };
}

// ---- Create ----

export async function createOrder(d: CreateOrderInput, actor: Actor) {
  assertMarketplaceMatches(d.source ?? "normal", d.items);
  // Không tự chỉ định skipVnWeighing -> lấy mặc định theo khách (khách chỉ lấy thuế, không cân ở Kho VN).
  let skipVnWeighing = d.skipVnWeighing;
  if (skipVnWeighing === undefined) {
    const customer = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { skipVnWeighingDefault: true } });
    skipVnWeighing = customer?.skipVnWeighingDefault ?? false;
  }
  const baseData = {
    customerId: d.customerId,
    saleId: actor.id,
    status: INITIAL_STATUS.order,
    orderDate: d.orderDate ?? new Date(),
    source: d.source ?? "normal",
    nick: d.nick ?? null,
    exchangeRate: d.exchangeRate,
    shipAmount: d.shipAmount ?? 0,
    shipCurrency: d.shipCurrency ?? "JPY",
    surchargeAmount: d.surchargeAmount ?? 0,
    surchargeCurrency: d.surchargeCurrency ?? "VND",
    discountAmount: d.discountAmount ?? 0,
    discountCurrency: d.discountCurrency ?? "VND",
    serviceFeeAmount: d.serviceFeeAmount ?? 0,
    serviceFeeCurrency: d.serviceFeeCurrency ?? "VND",
    jpDomesticShipAmount: d.jpDomesticShipAmount ?? 0,
    jpDomesticShipCurrency: d.jpDomesticShipCurrency ?? "JPY",
    intlShipAmount: d.intlShipAmount ?? 0,
    intlShipCurrency: d.intlShipCurrency ?? "VND",
    commissionPercent: d.commissionPercent ?? 0,
    needsCheck: d.needsCheck ?? false,
    checkNote: d.checkNote ?? null,
    externalWarehouse: d.externalWarehouse ?? false,
    skipVnWeighing,
    items: { create: d.items },
  };
  // Đơn + món + kiện + trừ thẻ (Mua hàng auto) + tổng tiền trong 1 transaction:
  // không có trạng thái "đã trừ thẻ mà chưa có đơn" hay đơn thiếu kiện/tổng.
  const { order, totals } = await createWithNextCode(async (tx, code) => {
    const o = await tx.order.create({ data: { ...baseData, id: uuid(), publicToken: uuid(), code } });
    if (d.trackings?.length) {
      for (const t of d.trackings) await claimOrCreateTracking(o.id, t.code, { jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg }, tx);
    } else {
      // Tự tạo 1 tracking trống gắn đơn -> hiện sẵn ở bảng Chuyến, điền mã tay sau
      await tx.tracking.create({ data: { id: uuid(), orderId: o.id, code: "", status: "linked" } });
    }
    // Yahoo/Mercari (thanh toán sau): KHÔNG trừ thẻ lúc tạo, chỉ trừ khi bấm "Đã thanh toán"
    if (!isPayLater(d.source ?? "normal"))
      await applyOrderCardCharges(tx, { orderId: o.id, code: o.code, items: d.items, exchangeRate: d.exchangeRate, fallbackDate: o.orderDate });
    return { order: o, totals: await recomputeOrderTotals(o.id, tx) };
  });
  await queueCustomerSheetSync(order.customerId);
  await audit(actor, order.id, "order.created");
  await logOrder({ orderId: order.id, actorId: actor.id, action: "created", changes: { items: d.items.length, totalVnd: totals?.totalVnd ?? null } });
  publish("order.created", actor, order.id, { code: order.code, source: order.source });
  return { ...order, ...totals };
}

export async function createConsignment(d: ConsignmentInput, actor: Actor) {
  if (d.shipRateCurrency === "JPY" && !d.exchangeRate) throw new LegacyError(400, "BAD_REQUEST", "Đơn giá JPY/kg cần nhập tỉ giá");
  const { order, totals } = await createWithNextCode(async (tx, code) => {
    const o = await tx.order.create({ data: {
      id: uuid(), customerId: d.customerId, saleId: actor.id, status: INITIAL_STATUS.consignment,
      exchangeRate: d.exchangeRate ?? null, publicToken: uuid(), code,
    } });
    await claimOrCreateTracking(o.id, d.code, {
      jpWeightKg: d.jpWeightKg ?? null, vnWeightKg: d.vnWeightKg ?? null,
      unitPriceVndPerKg: d.unitPriceVndPerKg ?? null, shipRateCurrency: d.shipRateCurrency,
      review: d.review ?? null, packedAt: d.packedAt ?? null,
    }, tx);
    return { order: o, totals: await recomputeOrderTotals(o.id, tx) };
  });
  await queueCustomerSheetSync(order.customerId);
  await audit(actor, order.id, "order.consignment_created");
  await logOrder({ orderId: order.id, actorId: actor.id, action: "created", changes: { consignment: true, totalVnd: totals?.totalVnd ?? null } });
  publish("order.created", actor, order.id, { code: order.code, consignment: true });
  return { ...order, ...totals };
}

// ---- Status (chọn tay) ----

export async function changeStatus(id: string, to: OrderStatus, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  assertTransition(order.status, to, "manual");
  const updated = await prisma.order.update({ where: { id: order.id }, data: { status: to } });
  await audit(actor, order.id, "order.status_changed", { from: order.status, to });
  await logOrder({ orderId: order.id, actorId: actor.id, action: "status_changed", changes: [{ field: "status", old: order.status, new: to }] });
  publish("order.status_changed", actor, order.id, { from: order.status, to, mode: "manual" });
  return updated;
}

// ---- Edit ----

export async function editOrder(id: string, d: EditOrderInput, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true, trackings: true } });
  if (!order) throw notFound();
  if (!isEditable(order.status)) throw new LegacyError(409, "LOCKED", "Chỉ sửa được đơn ở trạng thái nháp/đã báo giá");
  if (d.items) assertMarketplaceMatches(order.source, d.items);

  const changes: { field: string; old: unknown; new: unknown }[] = [];
  const diff = (field: string, oldV: unknown, newV: unknown) => {
    if (newV !== undefined && String(oldV ?? "") !== String(newV ?? "")) changes.push({ field, old: oldV ?? null, new: newV });
  };

  const data: Record<string, unknown> = {};
  if (d.orderDate !== undefined) { diff("orderDate", order.orderDate, d.orderDate); data.orderDate = d.orderDate; }
  if (d.needsCheck !== undefined) { diff("needsCheck", order.needsCheck, d.needsCheck); data.needsCheck = d.needsCheck; }
  if (d.checkNote !== undefined) { diff("checkNote", order.checkNote, d.checkNote); data.checkNote = d.checkNote; }
  if (d.externalWarehouse !== undefined) { diff("externalWarehouse", order.externalWarehouse, d.externalWarehouse); data.externalWarehouse = d.externalWarehouse; }
  if (d.skipVnWeighing !== undefined) { diff("skipVnWeighing", order.skipVnWeighing, d.skipVnWeighing); data.skipVnWeighing = d.skipVnWeighing; }
  if (d.customerId) { diff("customerId", order.customerId, d.customerId); data.customerId = d.customerId; }
  if (d.nick !== undefined) { diff("nick", order.nick, d.nick); data.nick = d.nick; }
  for (const f of PRICING_FIELDS) {
    const nv = d[f];
    if (nv !== undefined) { diff(f, (order as Record<string, unknown>)[f], nv); data[f] = nv; }
  }

  if (d.items) {
    diff("items", order.items.map((i) => `${i.name} x${i.qty} @${Number(i.unitPriceJpy)}`).join("; "),
      d.items.map((i) => `${i.name} x${i.qty} @${i.unitPriceJpy}`).join("; "));
    data.items = { create: d.items };
  }

  // Upsert kiện (tracking) theo id; xóa kiện bị bỏ khỏi danh sách
  let toDelete: string[] = [];
  if (d.trackings !== undefined) {
    const keepIds = d.trackings.filter((t) => t.id).map((t) => t.id!);
    toDelete = order.trackings.filter((t) => !keepIds.includes(t.id)).map((t) => t.id);
    // Kiện đã có khoản phải trả kho/cty (着払い...) -> FK chặn xóa; báo rõ thay vì lỗi DB thô.
    const costs = await repo.findCompanyCostsOnTrackings(toDelete);
    if (costs.length) {
      const ids = new Set(costs.map((c) => c.refId));
      const codes = order.trackings.filter((t) => ids.has(t.id)).map((t) => t.code || "(chưa có mã)").join(", ");
      throw new LegacyError(409, "TRACKING_HAS_COST",
        `Kiện ${codes} đã có khoản phải trả kho/cty (着払い...) - xóa khoản đó ở "Phải trả kho/cty" trước khi bỏ kiện khỏi đơn`);
    }
  }

  // Thay món + kiện + thông tin đơn + trừ lại thẻ + tổng tiền: 1 transaction (không để món mới mà giao dịch thẻ theo món cũ).
  const { totals, updated } = await prisma.$transaction(async (tx) => {
    if (d.items) await tx.orderItem.deleteMany({ where: { orderId: order.id } });
    if (d.trackings !== undefined) {
      if (toDelete.length) {
        await tx.trackingLog.deleteMany({ where: { trackingId: { in: toDelete } } });
        await tx.tracking.deleteMany({ where: { id: { in: toDelete } } });
      }
      for (const t of d.trackings) {
        if (t.id) await tx.tracking.update({ where: { id: t.id }, data: { code: t.code, jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg } });
        else await claimOrCreateTracking(order.id, t.code, { jpWeightKg: t.jpWeightKg, unitPriceVndPerKg: t.unitPriceVndPerKg }, tx);
      }
    }
    await tx.order.update({ where: { id: order.id }, data: data as Prisma.OrderUncheckedUpdateInput });
    // Yahoo/Mercari chưa thanh toán -> không đụng thẻ; đã TT thì tính lại theo món mới
    if (d.items && (!isPayLater(order.source) || order.yahooPaidAt)) {
      await reverseOrderCardCharges(tx, order.id);
      await applyOrderCardCharges(tx, { orderId: order.id, code: order.code, items: d.items, exchangeRate: d.exchangeRate ?? order.exchangeRate, fallbackDate: d.orderDate ?? order.orderDate });
    }
    const totals = await recomputeOrderTotals(order.id, tx);
    return { totals, updated: await tx.order.findUnique({ where: { id: order.id } }) };
  });
  if (d.trackings !== undefined) diff("trackings", order.trackings.map((t) => t.code).join(", "), d.trackings.map((t) => t.code).join(", "));
  diff("totalVnd", order.totalVnd, totals?.totalVnd ?? null);

  await queueCustomerSheetSync(order.customerId);
  if (d.customerId && d.customerId !== order.customerId) await queueCustomerSheetSync(d.customerId);
  await audit(actor, order.id, "order.updated");
  if (changes.length) await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes });
  publish("order.updated", actor, order.id, { fields: changes.map((c) => c.field) });
  return updated;
}

// ---- Thanh toán sau (Yahoo/Mercari) ----

export async function payLaterOrder(id: string, input: { walletId: string; paidAt?: Date }, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw notFound();
  if (!isPayLater(order.source)) throw new LegacyError(409, "NOT_YAHOO", "Chỉ đơn Yahoo/Mercari mới thanh toán sau");
  if (order.yahooPaidAt) throw new LegacyError(409, "ALREADY_PAID", "Đơn đã thanh toán");
  const wallet = await prisma.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw new LegacyError(404, "WALLET_NOT_FOUND");
  const paidAt = input.paidAt ?? new Date();
  const items = order.items.map((i) => ({ unitPriceJpy: i.unitPriceJpy, qty: i.qty, shipJpy: i.shipJpy, paymentMethod: wallet.name, purchaseDate: i.purchaseDate }));
  await prisma.$transaction(async (tx) => {
    // Chốt yahooPaidAt có điều kiện trước -> bấm 2 lần / 2 request song song không trừ thẻ 2 lần.
    const claimed = await tx.order.updateMany({ where: { id: order.id, yahooPaidAt: null }, data: { yahooPaidAt: paidAt } });
    if (claimed.count === 0) throw new LegacyError(409, "ALREADY_PAID", "Đơn đã thanh toán");
    // gán thẻ vào tất cả món rồi trừ (dùng chung logic auto-charge)
    await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { paymentMethod: wallet.name } });
    // Ngày ghi sổ ưu tiên: ngày mua món (nếu có) -> ngày đặt đơn -> KHÔNG dùng ngày bấm "Đã thanh toán"
    // (kế toán có thể xác nhận trễ nhiều ngày, dồn hết giao dịch vào 1 ngày là sai thực tế).
    await applyOrderCardCharges(tx, { orderId: order.id, code: order.code, items, exchangeRate: order.exchangeRate, fallbackDate: order.orderDate });
  });
  await audit(actor, order.id, "order.yahoo_paid", { wallet: wallet.name });
  await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes: { yahooThanhToan: wallet.name } });
  publish("order.updated", actor, order.id, { yahooPaid: true });
}

// Hủy thanh toán Yahoo/Mercari -> hoàn tiền về thẻ
export async function unpayLaterOrder(id: string, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  const notPaid = () => new LegacyError(409, "NOT_PAID", "Đơn chưa thanh toán");
  if (!isPayLater(order.source) || !order.yahooPaidAt) throw notPaid();
  await prisma.$transaction(async (tx) => {
    const released = await tx.order.updateMany({ where: { id: order.id, yahooPaidAt: { not: null } }, data: { yahooPaidAt: null } });
    if (released.count === 0) throw notPaid();
    await reverseOrderCardCharges(tx, order.id);
  });
  await audit(actor, order.id, "order.yahoo_unpaid");
  await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes: { yahooHuyThanhToan: true } });
  publish("order.updated", actor, order.id, { yahooPaid: false });
}

// ---- Yêu cầu sửa ----

export async function requestFix(id: string, note: string, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  await prisma.order.update({ where: { id: order.id }, data: { fixRequest: note, fixRequestedAt: new Date() } });
  await audit(actor, order.id, "order.fix_requested", { note });
  await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes: { yeuCauSua: note } });
}

// Sale đánh dấu đã sửa xong -> gỡ yêu cầu
export async function resolveFix(id: string, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  await prisma.order.update({ where: { id: order.id }, data: { fixRequest: null, fixRequestedAt: null } });
  await audit(actor, order.id, "order.fix_resolved");
  await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes: { daSuaXong: true } });
}

// ---- Delete ----

export async function deleteOrder(id: string, force: boolean, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id }, include: { payments: true, trackings: true } });
  if (!order) throw notFound();
  if (order.payments.length > 0) {
    if (!force) throw new LegacyError(409, "HAS_PAYMENTS", "Đơn đã có giao dịch, không xóa được");
    // Force chỉ cho admin/super_admin: xóa cả giao dịch + hoàn lại số dư ví
    if (!actor.roles.some((r) => ["super_admin", "admin"].includes(r)))
      throw new LegacyError(403, "FORBIDDEN", "Chỉ Admin được xóa đơn đã có giao dịch");
    await prisma.$transaction(async (tx) => {
      await reversePaymentWallets(tx, order.payments);
      await reverseOrderCardCharges(tx, order.id);
      // Chỉ xoá dòng sổ của phiếu thu/chi vừa hoàn số dư. Giao dịch thẻ nhập tay gắn đơn được giữ (gỡ liên kết
      // trong detachAndDeleteOrder) - trước đây bị xoá mà không hoàn số dư, làm lệch ví.
      await tx.walletTxn.deleteMany({ where: { refOrderId: order.id, type: { in: ["deposit", "final", "refund"] } } });
      await tx.payment.deleteMany({ where: { orderId: order.id } });
      await repo.detachAndDeleteOrder(tx, order.id);
    });
    await afterDelete(order, actor, "order.force_deleted", { payments: order.payments.length });
    return;
  }
  // Không có phiếu thu/chi: hoàn số dư thẻ (Mua hàng auto) + gỡ công nợ/tracking rồi xóa đơn - tất cả 1 transaction.
  await prisma.$transaction(async (tx) => {
    await reverseOrderCardCharges(tx, order.id);
    await repo.detachAndDeleteOrder(tx, order.id);
  });
  await afterDelete(order, actor, "order.deleted");
}

async function afterDelete(order: Order, actor: Actor, action: string, metadata?: Record<string, unknown>) {
  await queueCustomerSheetSync(order.customerId);
  await audit(actor, order.id, action, metadata);
  publish("order.deleted", actor, order.id, { code: order.code, force: action === "order.force_deleted" });
}
