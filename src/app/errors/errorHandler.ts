import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import { AppError } from "./AppError.js";
import { logError } from "../../infrastructure/systemLog.js";

// Đưa mọi lỗi đã biết về AppError; null = lỗi không lường trước (500).
function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new AppError("VALIDATION", 400, "Dữ liệu không hợp lệ", err.flatten());
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") return new AppError("NOT_FOUND", 404, "Không tìm thấy");
    if (err.code === "P2002") return new AppError("CONFLICT", 409, "Dữ liệu bị trùng", err.meta);
    if (err.code === "P2003") return new AppError("CONFLICT", 409, "Đang được dữ liệu khác tham chiếu", err.meta);
  }
  if ((err as { type?: string })?.type === "entity.parse.failed") return new AppError("VALIDATION", 400, "JSON không hợp lệ");
  return null;
}

// Nơi DUY NHẤT serialize lỗi HTTP: { error, message?, detail?, requestId } - frontend đọc `error` và `message`.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const known = toAppError(err);
  if (known) return res.status(known.status).json({ ...known.toBody(), requestId: req.requestId });
  const e = err as { message?: string; stack?: string };
  logError({
    request_id: req.requestId, method: req.method, url: req.originalUrl, user_id: req.user?.id,
    err: { message: e?.message, stack: e?.stack },
  }, "request_failed");
  res.status(500).json({ error: "INTERNAL", requestId: req.requestId });
}
