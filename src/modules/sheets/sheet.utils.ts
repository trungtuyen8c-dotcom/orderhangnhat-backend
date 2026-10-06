// Helper thuần dùng chung cho các sheet sync (không gọi Google, không gọi DB).

// Format theo giờ VN (UTC+7) bất kể timezone của server -> tránh lệch -1 ngày.
const VN_OFFSET_MS = 7 * 3600 * 1000;
export function vnDate(d: Date | string | number): Date {
  return new Date(new Date(d).getTime() + VN_OFFSET_MS);
}
export function fmtDate(d: Date | null | undefined): string {
  if (!d) return "";
  const dt = vnDate(d);
  return `${String(dt.getUTCDate()).padStart(2, "0")}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${dt.getUTCFullYear()}`;
}

// "YYYY-MM-DD" (theo UTC của mốc lưu trong DB) - khóa ngày dùng chung cho packedAt / tab ngày / PackDayLock.
export const isoDay = (d: Date | string | number) => new Date(d).toISOString().slice(0, 10);

// Tên tab kiểu "26.6" / "8.6" = ngày.tháng -> ngày đóng. Bỏ tab không phải ngày (vd "TRANG MẪU").
export function tabDate(title: string, now: Date = new Date()): Date | null {
  const m = title.trim().match(/^0*(\d{1,2})[.\/-]0*(\d{1,2})$/);
  if (!m) return null;
  const d = Number(m[1]), mo = Number(m[2]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  let dt = new Date(now.getFullYear(), mo - 1, d);
  // Tab không ghi năm - quét tab "31.12" đầu tháng 1 năm sau sẽ ghép nhầm thành 31/12 NĂM SAU (tương lai gần
  // 1 năm) nếu cứ lấy năm hiện tại. Ra tương lai hơn 30 ngày -> chắc chắn là tab của năm trước, lùi lại 1 năm.
  if (dt.getTime() - now.getTime() > 30 * 86400000) dt = new Date(now.getFullYear() - 1, mo - 1, d);
  return isNaN(dt.getTime()) ? null : dt;
}

// Mã tracking hợp lệ: không rỗng, không có dấu cách, >= 8 ký tự chữ-số (bỏ "0", tiêu đề, GK/GH...)
export function isTrackingCode(v: string): boolean {
  const c = (v ?? "").trim();
  return c.length >= 8 && /^[A-Za-z0-9._-]+$/.test(c);
}

// Checkbox "Đã xử lý" đọc formatted value -> tùy locale bảng tính có thể ra "TRUE" hoặc "ĐÚNG" (đã tick), chấp nhận vài biến thể
export function isChecked(v: string): boolean {
  const s = (v ?? "").trim().toUpperCase();
  return s === "TRUE" || s === "ĐÚNG" || s === "1";
}

// "Vàng" do kho tự tô tay trong sheet nháp trước khi chốt nộp hải quan - không phải màu hệ thống tự ghi
// (khác PURPLE/ORANGE/GREEN/YELLOW cố định ở warehouse sync), nên chỉ nhận diện theo sắc thái vàng
// chứ không so khớp RGB chính xác (người dùng có thể chọn bất kỳ sắc vàng nào trong bảng màu Google Sheets).
export function looksYellow(bg?: { red?: number; green?: number; blue?: number }): boolean {
  if (!bg) return false;
  const r = bg.red ?? 0, g = bg.green ?? 0, b = bg.blue ?? 0;
  return r > 0.9 && g > 0.75 && b < 0.75 && r - b > 0.15;
}
