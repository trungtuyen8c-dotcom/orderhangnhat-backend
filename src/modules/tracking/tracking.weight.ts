// Cân tính tiền của 1 tracking: ưu tiên cân Kho VN, chưa cân VN thì dùng cân Nhật.
export const effKg = (t: { jpWeightKg: unknown; vnWeightKg: unknown }) =>
  t.vnWeightKg != null ? Number(t.vnWeightKg) : Number(t.jpWeightKg ?? 0);
