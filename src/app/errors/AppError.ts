import type { ErrorCode } from "./errorCodes.js";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public detail?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }

  static badRequest(message: string, detail?: unknown, code: ErrorCode = "VALIDATION") {
    return new AppError(code, 400, message, detail);
  }
  static notFound(message = "Không tìm thấy", code: ErrorCode = "NOT_FOUND") {
    return new AppError(code, 404, message);
  }
  static conflict(message: string, code: ErrorCode = "CONFLICT", detail?: unknown) {
    return new AppError(code, 409, message, detail);
  }
  static forbidden(message = "Không có quyền") {
    return new AppError("FORBIDDEN", 403, message);
  }
  static invalidState(message: string, detail?: unknown) {
    return new AppError("STATE_INVALID_TRANSITION", 409, message, detail);
  }
}
