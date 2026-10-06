import type { ErrorCode } from "./errorCodes.js";

// Lỗi nghiệp vụ duy nhất của hệ thống. errorHandler serialize thành { error, message?, detail?, requestId }.
// message rỗng/không truyền -> body không có `message` (frontend dùng `message ?? fallback`).
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message?: string,
    public detail?: unknown,
  ) {
    super(message ?? "");
    this.name = "AppError";
  }

  toBody(): { error: ErrorCode; message?: string; detail?: unknown } {
    return {
      error: this.code,
      ...(this.message ? { message: this.message } : {}),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
    };
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
