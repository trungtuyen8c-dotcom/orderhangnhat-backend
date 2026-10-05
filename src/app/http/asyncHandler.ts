import type { NextFunction, Request, RequestHandler, Response } from "express";

// Express 4 không tự bắt Promise reject - mọi handler async phải bọc qua đây.
export const asyncHandler =
  <Req extends Request = Request>(fn: (req: Req, res: Response, next: NextFunction) => unknown): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req as Req, res, next)).catch(next);
  };
