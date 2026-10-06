import type { ZodTypeAny, z } from "zod";
import { AppError } from "../errors/AppError.js";

// safeParse -> 400 { error: "BAD_REQUEST" } (giữ mã cũ frontend đang nhận; ZodError ném thẳng thì ra VALIDATION).
export function parseOr400<S extends ZodTypeAny>(schema: S, data: unknown, withDetail = false): z.infer<S> {
  const p = schema.safeParse(data);
  if (!p.success) throw new AppError("BAD_REQUEST", 400, undefined, withDetail ? p.error.flatten() : undefined);
  return p.data;
}
