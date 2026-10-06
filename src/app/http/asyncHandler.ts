import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 không tự bắt Promise reject - mọi handler async phải bọc qua đây.
// new Promise bắt cả lỗi throw đồng bộ (vd parseOr400 trong handler không async).
export const asyncHandler =
  <Req extends Request = Request>(fn: (req: Req, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    new Promise((resolve) => resolve(fn(req as Req, res, next))).catch(next);
  };
