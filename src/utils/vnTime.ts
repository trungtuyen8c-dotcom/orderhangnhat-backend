// Giờ VN = UTC+7. Server chạy giờ UTC (không set TZ) nên mọi chỗ suy ngày/tháng lịch VN từ 1 timestamp
// thật (packedAt, createdAt, ...) phải quy đổi qua đây - không tự viết getFullYear()/getMonth() (= giờ
// server) rồi bucket theo tháng/ngày, sẽ lệch cho khung 00:00-06:59 giờ VN (rơi vào ngày/tháng UTC trước đó).
const VN_OFFSET_MS = 7 * 3600 * 1000;

// FE gửi "YYYY-MM-DD" luôn hiểu là ngày lịch VN - parse mốc đầu/cuối ngày theo giờ VN.
export const vnDayStart = (d: string) => new Date(`${d}T00:00:00+07:00`);
export const vnDayEnd = (d: string) => new Date(`${d}T23:59:59.999+07:00`);

// "YYYY-MM" theo lịch VN của 1 timestamp thật.
export const vnMonthKey = (d: Date | string) => {
  const vn = new Date(new Date(d).getTime() + VN_OFFSET_MS);
  return `${vn.getUTCFullYear()}-${String(vn.getUTCMonth() + 1).padStart(2, "0")}`;
};

// [start, end) theo giờ VN cho tháng "YYYY-MM" - dùng cho where: { gte: start, lt: end }.
export function vnMonthRange(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  const start = vnDayStart(`${month}-01`);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const end = vnDayStart(`${nextY}-${String(nextM).padStart(2, "0")}-01`);
  return { start, end };
}
