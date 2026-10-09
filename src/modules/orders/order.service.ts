import { v4 as uuid } from "uuid";
import type { Order, OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../../infrastructure/prisma.js";
import { logAudit, logAuditTx, logOrder } from "../../app/audit.js";
import { AppError } from "../../app/errors/AppError.js";
import { paged, type PageParams } from "../../app/http/pagination.js";
import { eventBus } from "../../app/events/EventBus.js";
import type { BusinessEventName } from "../../app/events/businessEvents.js";
import { detectMarketplace } from "../../integrations/marketplace/scrape.js";
import { applyOrderCardCharges, hasOrderCardCharges, reverseOrderCardCharges } from "../accounting/orderCard.js";
import { reversePaymentWallets } from "../accounting/wallet.service.js";
import { claimOrCreateTracking } from "../tracking/tracking.repository.js";
import { queueCustomerSheetSync } from "../sheets/sheet.jobs.js";
import { recomputeOrderTotals } from "./order.totals.js";
import {
  allowedActions, assertUserTransition, checkTransitionPrerequisites, findTransitionTo, INITIAL_STATUS, invalidTransition,
  isEditable, type AllowedAction, type OrderAction,
} from "./order.state.js";
import * as repo from "./order.repository.js";
import { scopeWhere, toOrderBy, toOrderSql, toOrderWhere, type OrderListFilter, type OrderSort } from "./order.listFilter.js";
import {
  chargesLater, isPayLater, PRICING_FIELDS, CARD_FIELDS,
  type ConsignmentInput, type CreateOrderInput, type EditOrderInput,
} from "./order.validation.js";

type Tx = Prisma.TransactionClient;
export type Actor = { id: string; roles: string[]; requestId?: string };

const notFound = () => new AppError("NOT_FOUND", 404);

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
  if (wrongUrl) throw new AppError("WRONG_MARKETPLACE", 400, `Link không khớp: ${wrongUrl}`);
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
  return { where: scopeWhere(source, excludeList), payLater: isPayLater(source) };
}

export type ListOrdersOptions = { withSummary?: boolean; canUpdateStatus?: boolean };

const isAdmin = (roles: string[]) => roles.some((r) => ["super_admin", "admin"].includes(r));

// Bước được bấm, đã lọc theo quyền người gọi (thiếu orders.update_status -> rỗng).
export const actionsFor = (status: OrderStatus, canUpdateStatus: boolean): AllowedAction[] =>
  canUpdateStatus ? allowedActions(status) : [];

const withActions = <T extends { status: OrderStatus }>(rows: T[], canUpdateStatus: boolean) =>
  rows.map((r) => ({ ...r, allowedActions: actionsFor(r.status, canUpdateStatus) }));

// Không có `page` -> mảng như cũ (tối đa 500 đơn mới nhất); có `page` -> { items, pagination }
// (+ `summary` khi withSummary: tổng/tháng trên TOÀN BỘ tập đã lọc, không theo trang/tháng đang xem).
// month="latest" chỉ có nghĩa khi có summary: resolve thành tháng mới nhất có đơn, trả lại ở summary.month.
export async function listOrders(filter: OrderListFilter, sort: OrderSort, page: PageParams | null, opts: ListOrdersOptions = {}) {
  const payLater = isPayLater(filter.source);
  const orderBy = toOrderBy(sort);
  const can = opts.canUpdateStatus ?? false;
  if (!page || !opts.withSummary) {
    const month = filter.month === "latest" ? undefined : filter.month;
    const r = await repo.listOrders(toOrderWhere(filter, month), payLater, page, orderBy);
    const rows = withActions(r.rows, can);
    return page ? paged(rows, r.total!, page) : rows;
  }
  const [months, pending] = await Promise.all([
    repo.monthBuckets(toOrderSql(filter)),
    payLater ? repo.pendingJpy(filter.source) : Promise.resolve(undefined),
  ]);
  const month = filter.month === "latest" ? months[0]?.month : filter.month;
  const r = await repo.listOrders(toOrderWhere(filter, month), payLater, page, orderBy);
  const summary = {
    count: months.reduce((s, m) => s + m.count, 0),
    totalVnd: months.reduce((s, m) => s + m.totalVnd, 0),
    months,
    month: month ?? null,
    ...(pending !== undefined ? { pendingJpy: pending } : {}),
  };
  return { ...paged(withActions(r.rows, can), r.total!, page), summary };
}

export async function listFacets(source: string, exclude: string) {
  return repo.listFacets(buildListWhere(source, exclude).where);
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
  // % công không nhập -> lấy mặc định của khách (cài ở trang Khách).
  const customer = await prisma.customer.findUnique({ where: { id: d.customerId }, select: { skipVnWeighingDefault: true, commissionPercentDefault: true } });
  const skipVnWeighing = d.skipVnWeighing ?? customer?.skipVnWeighingDefault ?? false;
  const commissionPercent = d.commissionPercent ?? Number(customer?.commissionPercentDefault ?? 0);
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
    commissionPercent,
    couponAmount: d.couponAmount ?? 0,
    couponCurrency: d.couponCurrency ?? "JPY",
    serviceFeeCustomerPays: d.serviceFeeCustomerPays ?? true,
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
    // Yahoo (thanh toán sau): KHÔNG trừ thẻ lúc tạo, chỉ trừ khi bấm "Đã thanh toán". Mercari/đơn thường: trừ ngay.
    if (!chargesLater(d.source ?? "normal"))
      await applyOrderCardCharges(tx, { orderId: o.id, code: o.code, items: d.items, exchangeRate: d.exchangeRate, fallbackDate: o.orderDate, adjust: o });
    return { order: o, totals: await recomputeOrderTotals(o.id, tx) };
  });
  await queueCustomerSheetSync(order.customerId);
  await audit(actor, order.id, "order.created");
  await logOrder({ orderId: order.id, actorId: actor.id, action: "created", changes: { items: d.items.length, totalVnd: totals?.totalVnd ?? null } });
  publish("order.created", actor, order.id, { code: order.code, source: order.source });
  return { ...order, ...totals };
}

export async function createConsignment(d: ConsignmentInput, actor: Actor) {
  if (d.shipRateCurrency === "JPY" && !d.exchangeRate) throw new AppError("BAD_REQUEST", 400, "Đơn giá JPY/kg cần nhập tỉ giá");
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

// ---- Status (state machine) ----

type StatusChange = {
  auditAction: "order.status_changed" | "order.status_corrected";
  auditMeta: Record<string, unknown>;
  eventMeta: Record<string, unknown>;
  logChanges: unknown;
};

async function loadForStatus(id: string) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  return order;
}

// Ghi status có điều kiện + audit trong 1 transaction; lịch sử/event/sheet chỉ chạy SAU commit.
async function commitStatusChange(order: Order, to: OrderStatus, actor: Actor, c: StatusChange) {
  const from = order.status;
  const updated = await prisma.$transaction(async (tx) => {
    // WHERE status = from: 2 request song song / bấm 2 lần -> request sau count 0 -> 409, không ghi đè.
    const r = await tx.order.updateMany({ where: { id: order.id, status: from }, data: { status: to } });
    if (r.count === 0) {
      throw new AppError("STATE_CONFLICT", 409, "Đơn vừa được đổi trạng thái bởi thao tác khác - tải lại để xem trạng thái mới", { from, to });
    }
    await logAuditTx(tx, {
      actorId: actor.id, targetId: order.id, action: c.auditAction, entity: "order", requestId: actor.requestId,
      before: { status: from }, after: { status: to }, metadata: c.auditMeta,
    });
    return tx.order.findUnique({ where: { id: order.id } });
  });
  await logOrder({ orderId: order.id, actorId: actor.id, action: "status_changed", changes: c.logChanges });
  // Giữ như bản cũ: đổi trạng thái không đồng bộ sheet khách (chưa có quyết định nghiệp vụ - xem open question).
  publish("order.status_changed", actor, order.id, { from, to, ...c.eventMeta });
  return updated;
}

function applyTransition(order: Order, action: OrderAction, to: OrderStatus, actor: Actor) {
  return commitStatusChange(order, to, actor, {
    auditAction: "order.status_changed",
    auditMeta: { transition: action },
    eventMeta: { action },
    logChanges: [{ field: "status", old: order.status, new: to, action }],
  });
}

export async function transitionOrder(id: string, action: OrderAction, actor: Actor) {
  const order = await loadForStatus(id);
  const t = assertUserTransition(order.status, action);
  checkTransitionPrerequisites(order, t);
  return applyTransition(order, t.action, t.to, actor);
}

// PATCH /:id/status { status } - tương thích ngược, vẫn bắt buộc đi đúng 1 bước trong bảng.
export async function changeStatus(id: string, to: OrderStatus, actor: Actor) {
  const order = await loadForStatus(id);
  const t = findTransitionTo(order.status, to);
  if (!t) throw invalidTransition(order.status, to, null);
  checkTransitionPrerequisites(order, t);
  return applyTransition(order, t.action, t.to, actor);
}

// Admin sửa sai: đặt bất kỳ trạng thái, bắt buộc lý do (validate ở route), audit before/after + lý do.
export async function correctOrderStatus(id: string, to: OrderStatus, reason: string, actor: Actor) {
  if (!isAdmin(actor.roles)) throw new AppError("FORBIDDEN", 403, "Chỉ Admin được sửa trạng thái đơn");
  const order = await loadForStatus(id);
  return commitStatusChange(order, to, actor, {
    auditAction: "order.status_corrected",
    auditMeta: { reason },
    eventMeta: { correction: true, reason },
    logChanges: [{ field: "status", old: order.status, new: to, correction: true, reason }],
  });
}

export async function getTransitions(id: string, canUpdateStatus: boolean, actor: Actor) {
  const order = await loadForStatus(id);
  return { status: order.status, actions: actionsFor(order.status, canUpdateStatus), canCorrect: canUpdateStatus && isAdmin(actor.roles) };
}

// ---- Edit ----

export async function editOrder(id: string, d: EditOrderInput, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true, trackings: true } });
  if (!order) throw notFound();
  if (!isEditable(order.status)) throw new AppError("LOCKED", 409, "Chỉ sửa được đơn ở trạng thái nháp/đã báo giá");
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
      throw new AppError("TRACKING_HAS_COST", 409,
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
    // Yahoo chưa thanh toán -> không đụng thẻ; đã TT thì tính lại theo món mới. Mercari cũ (tạo trước khi trừ thẻ
    // ngay, chưa có giao dịch tự động - có thể kế toán đã ghi tay) -> không tự trừ khi sửa, tránh trừ trùng.
    const recharge = chargesLater(order.source) ? !!order.yahooPaidAt
      : order.source === "mercari" ? await hasOrderCardCharges(tx, order.id) : true;
    const cardChanged = !!d.items || CARD_FIELDS.some((f) => d[f] !== undefined);
    if (cardChanged && recharge) {
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: { items: true } });
      await reverseOrderCardCharges(tx, order.id);
      await applyOrderCardCharges(tx, { orderId: order.id, code: order.code, items: fresh.items, exchangeRate: fresh.exchangeRate, fallbackDate: fresh.orderDate, adjust: fresh });
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
  if (!chargesLater(order.source)) throw new AppError("NOT_YAHOO", 409, "Chỉ đơn Yahoo mới thanh toán sau");
  if (order.yahooPaidAt) throw new AppError("ALREADY_PAID", 409, "Đơn đã thanh toán");
  const wallet = await prisma.wallet.findUnique({ where: { id: input.walletId } });
  if (!wallet) throw new AppError("WALLET_NOT_FOUND", 404);
  const paidAt = input.paidAt ?? new Date();
  const items = order.items.map((i) => ({ unitPriceJpy: i.unitPriceJpy, qty: i.qty, shipJpy: i.shipJpy, paymentMethod: wallet.name, purchaseDate: i.purchaseDate }));
  await prisma.$transaction(async (tx) => {
    // Chốt yahooPaidAt có điều kiện trước -> bấm 2 lần / 2 request song song không trừ thẻ 2 lần.
    const claimed = await tx.order.updateMany({ where: { id: order.id, yahooPaidAt: null }, data: { yahooPaidAt: paidAt } });
    if (claimed.count === 0) throw new AppError("ALREADY_PAID", 409, "Đơn đã thanh toán");
    // gán thẻ vào tất cả món rồi trừ (dùng chung logic auto-charge)
    await tx.orderItem.updateMany({ where: { orderId: order.id }, data: { paymentMethod: wallet.name } });
    // Ngày ghi sổ ưu tiên: ngày mua món (nếu có) -> ngày đặt đơn -> KHÔNG dùng ngày bấm "Đã thanh toán"
    // (kế toán có thể xác nhận trễ nhiều ngày, dồn hết giao dịch vào 1 ngày là sai thực tế).
    await applyOrderCardCharges(tx, { orderId: order.id, code: order.code, items, exchangeRate: order.exchangeRate, fallbackDate: order.orderDate, adjust: order });
  });
  await audit(actor, order.id, "order.yahoo_paid", { wallet: wallet.name });
  await logOrder({ orderId: order.id, actorId: actor.id, action: "updated", changes: { yahooThanhToan: wallet.name } });
  publish("order.updated", actor, order.id, { yahooPaid: true });
}

// Hủy thanh toán Yahoo -> hoàn tiền về thẻ
export async function unpayLaterOrder(id: string, actor: Actor) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound();
  const notPaid = () => new AppError("NOT_PAID", 409, "Đơn chưa thanh toán");
  if (!chargesLater(order.source) || !order.yahooPaidAt) throw notPaid();
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
    if (!force) throw new AppError("HAS_PAYMENTS", 409, "Đơn đã có giao dịch, không xóa được");
    // Force chỉ cho admin/super_admin: xóa cả giao dịch + hoàn lại số dư ví
    if (!isAdmin(actor.roles))
      throw new AppError("FORBIDDEN", 403, "Chỉ Admin được xóa đơn đã có giao dịch");
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
