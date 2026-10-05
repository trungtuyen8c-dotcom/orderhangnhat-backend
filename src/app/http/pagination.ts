import type { Request } from "express";

export type PageParams = { page: number; pageSize: number; skip: number; take: number };

// Phân trang opt-in: chỉ bật khi client gửi `page` - giữ tương thích frontend cũ đang nhận mảng.
export function readPage(req: Request, defaultSize = 50, maxSize = 200): PageParams | null {
  if (req.query.page === undefined) return null;
  const page = Math.max(1, Number.parseInt(String(req.query.page), 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(String(req.query.pageSize ?? defaultSize), 10) || defaultSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function paged<T>(items: T[], total: number, p: PageParams) {
  return { items, pagination: { page: p.page, pageSize: p.pageSize, total, totalPages: Math.ceil(total / p.pageSize) } };
}
