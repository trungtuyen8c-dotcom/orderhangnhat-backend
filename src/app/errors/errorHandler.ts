import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "./AppError.js";
import { logError } from "../../utils/systemLog.js";

// Body lỗi giữ dạng { error, message?, detail?, requestId } - frontend đang đọc `error` và `message`.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message, detail: err.detail, requestId: req.requestId });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: "VALIDATION", message: "Dữ liệu không hợp lệ", detail: err.flatten(), requestId: req.requestId });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return res.status(404).json({ error: "NOT_FOUND", message: "Không tìm thấy", requestId: req.requestId });
    if (err.code === "P2002") return res.status(409).json({ error: "CONFLICT", message: "Dữ liệu bị trùng", detail: err.meta, requestId: req.requestId });
    if (err.code === "P2003") return res.status(409).json({ error: "CONFLICT", message: "Đang được dữ liệu khác tham chiếu", detail: err.meta, requestId: req.requestId });
  }
  const e = err as { message?: string; stack?: string; type?: string; status?: number };
  if (e?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "VALIDATION", message: "JSON không hợp lệ", requestId: req.requestId });
  }
  logError({
    request_id: req.requestId, method: req.method, url: req.originalUrl, user_id: req.user?.id,
    err: { message: e?.message, stack: e?.stack },
  }, "request_failed");
  res.status(500).json({ error: "INTERNAL", requestId: req.requestId });
}
