import { prisma } from "../../infrastructure/prisma.js";
import { serviceAccountEmail, serviceAccountEnabled } from "../../integrations/google/googleAuth.js";
import {
  backgroundRequest, batchUpdate, clearValues, colLetter, ensureSheetTab, getSheetIdByTitle, getSpreadsheet, getValues,
  listSheetTitles, numberFormatRequest, protectedRangeRequest, sleep, updateValues,
} from "../../integrations/google/googleSheets.client.js";
import type { RgbColor, SheetsRequest } from "../../integrations/google/google.types.js";
import { trackingShipVnd } from "../orders/order.totals.js";
import { logWarn, logError } from "../../infrastructure/systemLog.js";
import { fmtDate, vnDate } from "./sheet.utils.js";

// ===== Xuất đơn theo từng khách: mỗi khách 1 file, mỗi tháng 1 tab, layout giống file khách =====
// Template MẶC ĐỊNH khi tạo tab mới (A→N). Nhiều khách tự chèn thêm cột riêng (vd "Đơn giá vận chuyển") vào
// giữa các cột này -> KHÔNG ghi theo vị trí cố định nữa, mà dò đúng cột theo TÊN tiêu đề thực tế của từng khách
// (xem readHeaderColumns/FIELD_HEADER bên dưới), để không bao giờ ghi lệch cột dù khách chèn/xóa cột tùy ý.
const ORDER_HEADER = [
  "Mã Link", "Ngày đặt", "ACC", "LINK đặt", "Phương thức thanh toán", "GIÁ WEB", "SHIP WEB",
  "% Công", "Tổng tiền bao gồm tiền công", "Cân-Kg", "Phụ thu", "TRACKING", "Đánh giá", "Ngày giao cho khách hàng",
];

// Các trường hệ thống TỰ QUẢN LÝ - chỉ ghi vào đúng cột có tiêu đề khớp tên bên dưới, tuyệt đối không đụng
// cột khác (vd "% Công") vì đó là kế toán tự nhập tay, không phải hệ thống ghi.
// 3 dòng cuối (shipRate/shipTotal/grandTotal) là cột MỚI 1 số khách tự thêm - chỉ ghi nếu khách CÓ cột đó.
const FIELD_HEADER = {
  code: "Mã Link", date: "Ngày đặt", acc: "ACC", url: "LINK đặt", method: "Phương thức thanh toán",
  giaWeb: "GIÁ WEB", ship: "SHIP WEB", total: "Tổng tiền bao gồm tiền công",
  rate: "tỉ giá", vndConverted: "Tổng tiền KH quy đổi VND",
  weight: "Cân-Kg", surcharge: "Phụ thu", tracking: "TRACKING", review: "Đánh giá",
  deliveredAt: "Ngày giao cho khách hàng",
  shipRate: "Đơn giá vận chuyển", shipTotal: "Tổng tiền vận chuyển", grandTotal: "Tổng tiền VND+ Vận chuyển",
  stored: "lưu kho", vnTrack: "tracking việt nam",
} as const;
type FieldKey = keyof typeof FIELD_HEADER;
type FieldRow = Partial<Record<FieldKey, string | number>>;
type MonthRows = { rows: FieldRow[]; jpyTotal: number; vndTotal: number };

type OrderFull = Awaited<ReturnType<typeof loadCustomerOrders>>[number];
function loadCustomerOrders(customerId: string) {
  return prisma.order.findMany({
    where: { customerId },
    orderBy: { createdAt: "asc" },
    include: { items: true, trackings: true, payments: true },
  });
}
type Deposit = Awaited<ReturnType<typeof loadDeposits>>[number];
function loadDeposits(customerId: string) {
  return prisma.customerDeposit.findMany({ where: { customerId }, orderBy: { paidAt: "asc" } });
}

// Dòng data theo TỪNG MÓN, gom theo THÁNG NGÀY MUA của chính món đó (không theo ngày tạo đơn).
// Trả field-key -> giá trị (không phải mảng theo vị trí cột) - runCustomerSync tự dò đúng cột theo tiêu đề thực
// của từng khách để ghi, tránh lệch cột khi khách chèn thêm cột riêng.
// Trả map: tháng -> { rows, jpyTotal: tổng ¥ (mirror "Tổng tiền"), vndTotal: tổng quy đổi ₫ các món có tỉ giá }.
// Khóa tháng có năm ("2026-03") - đơn tháng 3/2025 và 3/2026 là 2 tháng khác nhau, không dồn chung 1 tab.
const monthKeyOf = (d: Date) => { const v = vnDate(d); return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}`; };

function buildRowsByMonth(orders: OrderFull[], codByTracking?: Map<string, number>, custShipRateVnd?: number | null): Map<string, MonthRows> {
  const byMonth = new Map<string, { date: Date; row: FieldRow; jpy: number; vnd: number }[]>();
  const bucket = (m: string) => { let b = byMonth.get(m); if (!b) { b = []; byMonth.set(m, b); } return b; };
  for (const o of orders) {
    const rate = Number(o.exchangeRate ?? 0);
    const surchargeVnd = o.surchargeCurrency === "JPY" ? Number(o.surchargeAmount) * rate : Number(o.surchargeAmount);
    // Phụ thu ¥ mà đơn chưa có tỉ giá -> không quy đổi được: giữ nguyên số ¥ (ghi rõ "¥"), không để thành 0.
    const surchargeJpyRaw = o.surchargeCurrency === "JPY" && !rate ? Number(o.surchargeAmount ?? 0) : 0;
    // % công (order.commissionPercent) - tính trên giá món + ship món (không gồm ship cả đơn), giống recomputeOrderTotals.
    const commissionPercent = Number(o.commissionPercent ?? 0);
    o.items.forEach((it, idx) => {
      const giaWeb = it.qty * Number(it.unitPriceJpy);
      const ship = Number(it.shipJpy ?? 0);
      const commissionJpy = (giaWeb + ship) * (commissionPercent / 100);
      const trk = o.trackings[idx];
      const purchaseDate = it.purchaseDate ?? o.createdAt;
      const m = monthKeyOf(purchaseDate);
      // Phụ thu = phụ thu tay của cả đơn (chỉ món đầu) + 着払い/COD kho báo riêng cho đúng mã tracking của món này
      const codVnd = trk ? (codByTracking?.get(trk.id) ?? 0) : 0;
      const surchargeCell = (idx === 0 ? surchargeVnd : 0) + codVnd;
      // Ship của cả đơn (order.shipAmount - phí ship/thanh toán tay, vd COMBINI) chỉ cộng vào món đầu (tránh nhân đôi
      // khi đơn nhiều món). Cùng đơn vị ¥ với ship món -> ghép thành công thức "=shipMón+shipĐơn" để khách bấm vào
      // sheet thấy rõ 2 khoản cộng ra sao; khác đơn vị (VND) thì cộng thẳng vào ₫ quy đổi, không ghép công thức được.
      const orderShipJpy = idx === 0 && o.shipCurrency === "JPY" ? Number(o.shipAmount ?? 0) : 0;
      const orderShipVndOnly = idx === 0 && o.shipCurrency !== "JPY" ? Number(o.shipAmount ?? 0) : 0;
      const shipCell: string | number = orderShipJpy > 0 ? (ship > 0 ? `=${ship}+${orderShipJpy}` : orderShipJpy) : (ship || "");
      // Ưu tiên cân VN (đã cân lại thực tế) nếu có - khớp đúng cân dùng để tính phí ship thật (trackingShipVnd),
      // không phải cân JP khai báo ban đầu, tránh sheet khách hiện cân khác với cân đã tính tiền.
      const weight = trk?.vnWeightKg != null ? Number(trk.vnWeightKg) : (trk?.jpWeightKg != null ? Number(trk.jpWeightKg) : null);
      // Quy đổi đúng ra ₫/kg để hiện khớp với "Tổng tiền vận chuyển" (= cân x đơn giá này) - đơn giá tracking có
      // thể để theo ¥ (shipRateCurrency) nên phải nhân tỉ giá, đơn giá mặc định của khách luôn tính sẵn theo ₫.
      // usingCustRate: đang fallback sang giá mặc định khách (luôn VND) -> KHÔNG được nhân tỉ giá dù
      // trk.shipRateCurrency cũ còn ghi "JPY" (đó là cờ cho giá riêng của tracking, không áp dụng cho giá khách).
      const usingCustRate = trk?.unitPriceVndPerKg == null;
      const rawShipRate = trk?.unitPriceVndPerKg != null ? Number(trk.unitPriceVndPerKg) : custShipRateVnd ?? null;
      const shipVndPerKg = rawShipRate != null ? (!usingCustRate && trk?.shipRateCurrency === "JPY" ? rawShipRate * rate : rawShipRate) : null;
      const shipTotal = trk ? trackingShipVnd(
        { ...trk, unitPriceVndPerKg: trk.unitPriceVndPerKg ?? custShipRateVnd ?? null, shipRateCurrency: usingCustRate ? "VND" : trk.shipRateCurrency },
        rate,
      ) : 0;
      const jpy = giaWeb + ship + commissionJpy + orderShipJpy;
      const vnd = (rate ? Math.round(jpy * rate) : 0) + orderShipVndOnly;
      const grandTotal = vnd + Math.round(shipTotal);
      const row: FieldRow = {
        code: o.items.length > 1 ? `${o.code}.${idx + 1}` : o.code,
        date: fmtDate(purchaseDate),
        acc: String(o.nick ?? ""),
        url: String(it.url ?? ""), method: String(it.paymentMethod ?? ""),
        giaWeb: giaWeb || "", ship: shipCell, total: jpy,
        rate: rate || "", vndConverted: vnd || "",
        weight: weight ?? "",
        surcharge: idx === 0 && surchargeJpyRaw
          ? `¥${surchargeJpyRaw.toLocaleString("ja-JP")}${codVnd ? ` + ${Math.round(codVnd)}` : ""}`
          : (surchargeCell ? Math.round(surchargeCell) : ""),
        shipRate: shipVndPerKg ? Math.round(shipVndPerKg) : "",
        shipTotal: shipTotal ? Math.round(shipTotal) : "",
        tracking: String(trk?.code ?? ""), review: String(trk?.review ?? ""),
        deliveredAt: trk?.deliveredAt ? fmtDate(trk.deliveredAt) : "",
        grandTotal: grandTotal ? grandTotal : "",
        // Chỉ tính "đang lưu kho" khi CHƯA ship (chưa có Tracking VN) - có Tracking VN rồi thì coi như đã ship,
        // tự bỏ chữ/màu "lưu kho" dù status DB vẫn còn "stored" (không reset lại khi nhập Tracking VN).
        stored: (trk?.status === "stored" && !trk?.vnTrackingCode) ? "lưu kho" : "",
        vnTrack: String(trk?.vnTrackingCode ?? ""),
      };
      bucket(m).push({ date: purchaseDate, row, jpy, vnd });
    });
  }
  const result = new Map<string, MonthRows>();
  for (const [m, entries] of byMonth) {
    entries.sort((a, b) => a.date.getTime() - b.date.getTime());
    result.set(m, {
      rows: entries.map((e) => e.row),
      jpyTotal: entries.reduce((s, e) => s + e.jpy, 0),
      vndTotal: entries.reduce((s, e) => s + e.vnd, 0),
    });
  }
  return result;
}

// Liệt kê tab tháng: không ghi năm ("Tháng 3", "T3", "3") và có năm ("Tháng 3/2027", "T3.2027", "3-2027").
type MonthTabs = { noYear: Map<number, string>; withYear: Map<string, string> };
async function listMonthTabs(sid: string): Promise<MonthTabs> {
  const noYear = new Map<number, string>();
  const withYear = new Map<string, string>();
  for (const title of await listSheetTitles(sid)) {
    const t = title.trim().toLowerCase();
    const my = t.match(/^(?:tháng|thang|t)?\s*0*(\d{1,2})\s*[./-]\s*(\d{4})$/);
    if (my && Number(my[1]) >= 1 && Number(my[1]) <= 12) { withYear.set(`${my[2]}-${my[1].padStart(2, "0")}`, title); continue; }
    const mm = t.match(/^(?:tháng|thang|t)?\s*0*(\d{1,2})$/);
    if (mm) noYear.set(Number(mm[1]), title);
  }
  return { noYear, withYear };
}

// Gán tab cho từng tháng-năm có dữ liệu. Tab không ghi năm ("Tháng 3") thuộc về năm SỚM NHẤT có dữ liệu tháng đó
// (năm nó được tạo ra) mà chưa có tab riêng ghi năm; các năm sau dùng/tạo "Tháng 3/2027" -> mỗi tháng của mỗi năm
// 1 tab riêng, năm mới không ghi đè tab năm cũ. Tab tháng không còn dữ liệu vẫn được trả về (để dọn dòng cũ).
export function planMonthTabs(dataKeys: Iterable<string>, tabs: MonthTabs): { key: string; tab: string; create: boolean }[] {
  const keys = [...new Set(dataKeys)].sort();
  const plan: { key: string; tab: string; create: boolean }[] = [];
  const usedNoYear = new Set<number>();
  for (const key of keys) {
    const [y, mm] = key.split("-");
    const m = Number(mm);
    const own = tabs.withYear.get(key);
    if (own) { plan.push({ key, tab: own, create: false }); continue; }
    if (!usedNoYear.has(m)) {
      usedNoYear.add(m);
      const plain = tabs.noYear.get(m);
      plan.push({ key, tab: plain ?? `Tháng ${m}`, create: !plain });
      continue;
    }
    plan.push({ key, tab: `Tháng ${m}/${y}`, create: true });
  }
  const planned = new Set(plan.map((p) => p.tab));
  for (const [m, tab] of tabs.noYear) if (!planned.has(tab)) plan.push({ key: `----${m}`, tab, create: false });
  for (const [key, tab] of tabs.withYear) if (!planned.has(tab)) plan.push({ key, tab, create: false });
  return plan;
}

// Dò dòng tiêu đề (có ô "Mã Link" ở BẤT KỲ cột nào - khách có thể chèn cột trước nó) trong 20 dòng đầu.
// Trả { row: 0, empty } nếu không thấy; empty = 20 dòng đầu trống hẳn (tab mới, được phép ghi template).
async function findHeaderRow(sid: string, tab: string): Promise<{ row: number; empty: boolean }> {
  const rows = await getValues(sid, tab, "A1:AZ20");
  for (let i = 0; i < rows.length; i++) if ((rows[i] ?? []).some((v) => (v ?? "").trim() === "Mã Link")) return { row: i + 1, empty: false };
  return { row: 0, empty: rows.every((r) => (r ?? []).every((v) => !(v ?? "").trim())) };
}

// Dò đúng cột (0-based) của từng field theo TÊN tiêu đề thực tế ở dòng header - khách chèn/xóa/đổi vị trí cột
// tùy ý vẫn ghi đúng, vì không dựa vào vị trí cố định A→N nữa. Field nào khách không có cột thì bỏ qua, không ghi.
async function readHeaderColumns(sid: string, tab: string, headerRow: number): Promise<Map<FieldKey, number>> {
  const cells = (await getValues(sid, tab, `${headerRow}:${headerRow}`))[0] ?? [];
  const map = new Map<FieldKey, number>();
  const byText = new Map<string, number>();
  cells.forEach((v, i) => { const t = (v ?? "").trim(); if (t && !byText.has(t)) byText.set(t, i); });
  for (const [key, label] of Object.entries(FIELD_HEADER) as [FieldKey, string][]) {
    const i = byText.get(label);
    if (i != null) map.set(key, i);
  }
  return map;
}

// Bảng màu cố định để tô theo ngày ship - cùng 1 chuỗi ngày luôn ra cùng 1 màu (ổn định qua nhiều lần sync),
// khác ngày thì (hầu hết) ra màu khác, giúp nhìn sheet là gom được lô hàng ship chung ngày mà không cần đọc chữ.
const DATE_COLORS: RgbColor[] = [
  { red: 0.80, green: 0.93, blue: 0.80 }, { red: 1, green: 0.85, blue: 0.6 }, { red: 0.88, green: 0.80, blue: 0.95 },
  { red: 1, green: 0.95, blue: 0.6 }, { red: 0.70, green: 0.85, blue: 0.95 }, { red: 1, green: 0.80, blue: 0.85 },
  { red: 0.85, green: 0.95, blue: 0.70 }, { red: 0.95, green: 0.80, blue: 0.70 }, { red: 0.75, green: 0.95, blue: 0.90 },
  { red: 0.90, green: 0.90, blue: 0.75 },
];
function colorForDate(dateStr: string): RgbColor {
  let h = 0;
  for (let i = 0; i < dateStr.length; i++) h = (h * 31 + dateStr.charCodeAt(i)) >>> 0;
  return DATE_COLORS[h % DATE_COLORS.length];
}

// Sổ thu tiền (cọc): dò đúng cột theo tiêu đề thực tế "Mã/Ngày/Tên khoản mục/Nội dung/Tiền" (khách chèn
// thêm cột ở phần đơn hàng phía trước làm cả khối này bị đẩy lệch chỗ) - không dùng vị trí cố định W:Z nữa.
// Cột "Mã" để khách tự điền. 3 ô TỔNG TT/CỌC/NỢ (H1:H3) là công thức riêng -> tự nhảy, không đụng ở đây.
function buildDepositRows(deps: { paidAt: Date; note: string | null; amountVnd: unknown }[]): (string | number)[][] {
  return deps.map((d) => [fmtDate(d.paidAt), "Thu tiền hàng", String(d.note ?? ""), Number(d.amountVnd)]);
}

type DepositHeader = { row: number; dateCol: number; amtCol: number };
async function findDepositHeader(sid: string, tab: string): Promise<DepositHeader | null> {
  const rows = await getValues(sid, tab, "A1:AZ40");
  for (let r = 0; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const idx = cells.findIndex((v) => (v ?? "").trim() === "Tên khoản mục");
    if (idx >= 1 && (cells[idx - 1] ?? "").trim() === "Ngày") {
      return { row: r + 1, dateCol: idx - 1, amtCol: idx + 2 };
    }
  }
  return null;
}

// Khóa các cột hệ thống tự ghi (Mã Link/Ngày đặt/.../TRACKING, khối TỔNG H1:H3, cột Ngày+Số tiền của sổ cọc)
// bằng Protected Range - chỉ service account được sửa, khách/staff được share file KHÔNG sửa/xóa được các ô
// này (cột khách tự thêm như "% Công" không đụng tới, vẫn tự do). Idempotent: chỉ add range nào chưa có
// (so theo `description`) - tránh add trùng mỗi lần sync (mỗi lần lưu đơn/cọc/tracking đều gọi lại).
async function protectManagedRanges(sid: string, gsid: number, headerRow: number, headerCols: Map<FieldKey, number>, depHeader: DepositHeader | null): Promise<void> {
  const saEmail = serviceAccountEmail();
  if (!saEmail) return;
  const desired = new Map<string, { startRowIndex: number; endRowIndex: number; startColumnIndex: number; endColumnIndex: number }>();
  for (const [key, col] of headerCols) desired.set(`sys:${key}`, { startRowIndex: headerRow - 1, endRowIndex: 100000, startColumnIndex: col, endColumnIndex: col + 1 });
  desired.set("sys:total", { startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 });
  if (depHeader) {
    desired.set("sys:dep-date", { startRowIndex: depHeader.row - 1, endRowIndex: 100000, startColumnIndex: depHeader.dateCol, endColumnIndex: depHeader.dateCol + 1 });
    desired.set("sys:dep-amt", { startRowIndex: depHeader.row - 1, endRowIndex: 100000, startColumnIndex: depHeader.amtCol, endColumnIndex: depHeader.amtCol + 2 });
  }
  try {
    const meta = await getSpreadsheet<{ sheets?: { properties: { sheetId: number }; protectedRanges?: { description?: string }[] }[] }>(
      sid, "sheets(properties(sheetId),protectedRanges(description))",
    );
    const existing = new Set((meta.sheets ?? []).find((s) => s.properties.sheetId === gsid)?.protectedRanges?.map((p) => p.description ?? "") ?? []);
    const reqs = [...desired].filter(([tag]) => !existing.has(tag)).map(([tag, range]) => protectedRangeRequest({ sheetId: gsid, ...range }, tag, [saEmail]));
    if (reqs.length) await batchUpdate(sid, reqs);
  } catch (e) {
    logError({ err: (e as Error).message }, "gsheets_protect_managed_ranges_failed");
  }
}

// 着払い/COD kho báo riêng theo từng mã tracking (nhập ở "Phải trả kho/cty") -> cộng vào cột Phụ thu đúng dòng đó
async function loadCodByTracking(orders: OrderFull[]): Promise<Map<string, number>> {
  const trackingIds = orders.flatMap((o) => o.trackings.map((t) => t.id));
  const codByTracking = new Map<string, number>();
  if (trackingIds.length) {
    const codRows = await prisma.companyCost.groupBy({ by: ["refId"], where: { kind: "chakubarai", refId: { in: trackingIds } }, _sum: { amountVnd: true } });
    for (const r of codRows) if (r.refId) codByTracking.set(r.refId, Number(r._sum.amountVnd ?? 0));
  }
  return codByTracking;
}

function groupDepositsByMonth(deposits: Deposit[]): Map<string, Deposit[]> {
  const depsByMonth = new Map<string, Deposit[]>();
  for (const d of deposits) { const m = monthKeyOf(d.paidAt); (depsByMonth.get(m) ?? depsByMonth.set(m, []).get(m)!).push(d); }
  return depsByMonth;
}

// Dòng tiêu đề đơn hàng. Tab trống hẳn -> ghi template mặc định ở dòng 1. Tab đã có nội dung mà không thấy
// "Mã Link" -> trả 0: KHÔNG ghi gì vào tab đó (không đè nội dung khách), để người dùng tự sửa tiêu đề.
async function ensureOrderHeader(sid: string, tab: string): Promise<number> {
  const header = await findHeaderRow(sid, tab);
  if (header.row) return header.row;
  if (!header.empty) return 0;
  await updateValues(sid, tab, "A1", { values: [ORDER_HEADER] });
  return 1;
}

// Ghi đơn hàng: đúng cột theo TÊN tiêu đề thực tế của khách (không theo vị trí cố định A→N).
async function writeOrderColumns(sid: string, tab: string, start: number, headerCols: Map<FieldKey, number>, fieldRows: FieldRow[]): Promise<void> {
  for (const [key, col] of headerCols) {
    const letter = colLetter(col);
    await clearValues(sid, tab, `${letter}${start}:${letter}100000`);
    if (fieldRows.length) {
      const colValues = fieldRows.map((r) => [r[key] ?? ""]);
      await updateValues(sid, tab, `${letter}${start}`, { majorDimension: "ROWS", values: colValues });
    }
  }
}

// Tô nền: "lưu kho" cam khi đang lưu kho (tự trắng khi ship), "Ngày giao" tô theo màu riêng từng ngày.
async function paintStatusColumns(sid: string, gsid: number, start: number, headerCols: Map<FieldKey, number>, fieldRows: FieldRow[]): Promise<void> {
  const ORANGE = { red: 1, green: 0.85, blue: 0.6 };
  const WHITE = { red: 1, green: 1, blue: 1 };
  const reqs: SheetsRequest[] = [];
  const clearCol = (col: number) =>
    reqs.push(backgroundRequest({ sheetId: gsid, startRowIndex: start - 1, endRowIndex: start + 499, startColumnIndex: col, endColumnIndex: col + 1 }, WHITE));
  const paintCell = (col: number, i: number, bg: RgbColor) =>
    reqs.push(backgroundRequest({ sheetId: gsid, startRowIndex: start - 1 + i, endRowIndex: start + i, startColumnIndex: col, endColumnIndex: col + 1 }, bg));

  const storedCol = headerCols.get("stored");
  if (storedCol != null) {
    clearCol(storedCol);
    fieldRows.forEach((r, i) => { if (r.stored === "lưu kho") paintCell(storedCol, i, ORANGE); });
  }
  const deliveredCol = headerCols.get("deliveredAt");
  if (deliveredCol != null) {
    clearCol(deliveredCol);
    fieldRows.forEach((r, i) => { if (typeof r.deliveredAt === "string" && r.deliveredAt) paintCell(deliveredCol, i, colorForDate(r.deliveredAt)); });
  }
  await batchUpdate(sid, reqs);
}

// Sổ thu tiền (cọc): dò đúng cột theo tiêu đề thực tế, để trống cột Mã. Trả header sổ cọc (null nếu tab không có).
async function writeDeposits(sid: string, tab: string, monthDeposits: Deposit[]): Promise<DepositHeader | null> {
  const depHeader = await findDepositHeader(sid, tab);
  if (depHeader) {
    const depStart = depHeader.row + 1;
    const c0 = colLetter(depHeader.dateCol);
    const c1 = colLetter(depHeader.amtCol);
    await clearValues(sid, tab, `${c0}${depStart}:${c1}100000`);
    if (monthDeposits.length) {
      await updateValues(sid, tab, `${c0}${depStart}`, { values: buildDepositRows(monthDeposits) });
    }
  }
  return depHeader;
}

// Khối TỔNG TT/CỌC/NỢ (H1/H2/H3): có tỉ giá -> thay hẳn sang ₫; không có -> giữ nguyên ¥.
async function writeTotals(sid: string, tab: string, gsid: number | null, jpyTotal: number, vndTotal: number, monthDeposits: Deposit[]): Promise<void> {
  const jpyDepositTotal = monthDeposits.filter((d) => d.currency === "JPY").reduce((s, d) => s + Number(d.amountOrig), 0);
  const vndDepositTotal = monthDeposits.filter((d) => d.currency === "VND").reduce((s, d) => s + Number(d.amountVnd), 0);
  const useVnd = vndTotal > 0;
  const h1 = useVnd ? vndTotal : jpyTotal;
  const h2 = useVnd ? vndDepositTotal : jpyDepositTotal;
  const h3 = h1 - h2;
  await updateValues(sid, tab, "H1:H3", { majorDimension: "COLUMNS", values: [[h1 || "", h2 || "", h3 || ""]] });
  // Dọn ô "Tổng/Nợ quy đổi ₫" cũ (bản trước ghi ở I:J, giờ gộp thẳng vào H nên không cần nữa)
  await clearValues(sid, tab, "I1:J3");
  if (gsid != null) {
    const pattern = useVnd ? "#,##0 \"₫\"" : "\"¥\"#,##0";
    await batchUpdate(sid, [numberFormatRequest({ sheetId: gsid, startRowIndex: 0, endRowIndex: 3, startColumnIndex: 7, endColumnIndex: 8 }, pattern)]);
  }
}

async function syncMonthTab(sid: string, tab: string, create: boolean, monthRows: MonthRows, monthDeposits: Deposit[]): Promise<void> {
  if (create) await ensureSheetTab(sid, tab);
  const { rows: fieldRows, jpyTotal, vndTotal } = monthRows;

  const header = await ensureOrderHeader(sid, tab);
  if (!header) { logWarn({ tab }, "gsheets_customer_tab_header_missing_skipped"); return; }
  const start = header + 1;
  const headerCols = await readHeaderColumns(sid, tab, header);
  const gsid = await getSheetIdByTitle(sid, tab);
  await writeOrderColumns(sid, tab, start, headerCols, fieldRows);

  if (gsid != null && (headerCols.has("stored") || headerCols.has("deliveredAt"))) {
    await paintStatusColumns(sid, gsid, start, headerCols, fieldRows);
  }

  const depHeader = await writeDeposits(sid, tab, monthDeposits);

  // Khóa các cột hệ thống tự ghi - khách/staff share file không sửa/xóa được, chỉ hệ thống ghi
  if (gsid != null) await protectManagedRanges(sid, gsid, header, headerCols, depHeader);

  await writeTotals(sid, tab, gsid, jpyTotal, vndTotal, monthDeposits);
}

async function runCustomerSync(customerId: string, attempt = 1): Promise<void> {
  if (!serviceAccountEnabled()) return;
  try {
    const customer = await prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer?.sheetId) return;
    const sid = customer.sheetId;
    const orders = await loadCustomerOrders(customerId);
    // Đẩy ngay khi NV ghi (kế toán xác nhận là việc nội bộ, không chờ mới lên sheet khách)
    const deposits = await loadDeposits(customerId);
    const codByTracking = await loadCodByTracking(orders);

    // Mỗi MÓN nhảy vào tháng theo ngày mua của chính nó
    const custShipRateVnd = customer.shipRatePerKg != null ? Number(customer.shipRatePerKg) : null;
    const rowsByMonth = buildRowsByMonth(orders, codByTracking, custShipRateVnd);
    const depsByMonth = groupDepositsByMonth(deposits);

    // Gồm cả các tab tháng đang tồn tại -> tháng không còn dữ liệu sẽ được dọn (tránh dòng cũ ở lại khi món đổi tháng theo ngày mua)
    const plan = planMonthTabs([...rowsByMonth.keys(), ...depsByMonth.keys()], await listMonthTabs(sid));
    for (const { key, tab, create } of plan) {
      await syncMonthTab(sid, tab, create, rowsByMonth.get(key) ?? { rows: [], jpyTotal: 0, vndTotal: 0 }, depsByMonth.get(key) ?? []);
    }
  } catch (e) {
    // Còn 1 phần dở dang (lỗi API giữa chừng) -> thử lại cả lượt sync 1 lần, tránh để lại dữ liệu cũ trên sheet khách
    if (attempt < 2) {
      logWarn({ err: (e as Error).message }, "gsheets_sync_customer_orders_retry");
      await sleep(3000);
      return runCustomerSync(customerId, attempt + 1);
    }
    logError({ err: (e as Error).message }, "gsheets_sync_customer_orders_failed");
  }
}

// Nối tiếp sync theo từng khách (tránh race khi tạo nhiều đơn liên tiếp ghi đè nhau). Không bao giờ throw.
const syncLocks = new Map<string, Promise<void>>();
export function syncCustomerOrders(customerId: string): Promise<void> {
  const prev = syncLocks.get(customerId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runCustomerSync(customerId));
  syncLocks.set(customerId, next);
  void next.finally(() => { if (syncLocks.get(customerId) === next) syncLocks.delete(customerId); });
  return next;
}
