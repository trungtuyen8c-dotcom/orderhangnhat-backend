import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodTypeAny, z } from "zod";
import { AppError } from "../errors/AppError.js";
import type { ErrorCode } from "../errors/errorCodes.js";

// Lỗi giữ đúng body cũ { error, message?, detail? } (không thêm requestId) - frontend, MCP và test
// đang khoá contract này cho các module auth/admin/api-keys/payroll/backup/scrape/public.
export class LegacyError extends AppError {
  constructor(status: number, code: string, message?: string, detail?: unknown) {
    super(code as ErrorCode, status, message ?? "", detail);
  }

  toBody() {
    return {
      error: this.code,
      ...(this.message ? { message: this.message } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
  }
}

// Như asyncHandler, nhưng LegacyError trả về đúng body cũ; lỗi khác đi tiếp tới errorHandler global.
export const handle =
  <Req extends Request = Request>(fn: (req: Req, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    // new Promise bắt cả lỗi throw đồng bộ (vd parseOr400 trong handler không async).
    new Promise((resolve) => resolve(fn(req as Req, res, next))).catch((e) => {
      if (e instanceof LegacyError) return res.status(e.status).json(e.toBody());
      next(e);
    });
  };

// safeParse -> 400 { error: "BAD_REQUEST" } (không dùng ZodError global vì nó trả mã VALIDATION).
export function parseOr400<S extends ZodTypeAny>(schema: S, data: unknown, withDetail = false): z.infer<S> {
  const p = schema.safeParse(data);
  if (!p.success) throw new LegacyError(400, "BAD_REQUEST", undefined, withDetail ? p.error.flatten() : undefined);
  return p.data;
}
