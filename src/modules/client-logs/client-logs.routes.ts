import { Router } from "express";
import { z } from "zod";
import { handle, parseOr400 } from "../../app/http/legacyError.js";
import { logError } from "../../infrastructure/systemLog.js";

export const clientLogsRouter = Router();

// Không authenticate: lỗi JS phía client (crash render, mất mạng, token hết hạn...) phải log được
// kể cả khi chưa đăng nhập hoặc access token đã chết.
const bodySchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  userEmail: z.string().max(200).optional(),
});

clientLogsRouter.post("/", handle((req, res) => {
  const { message, ...meta } = parseOr400(bodySchema, req.body);
  logError({ source: "frontend", request_id: req.requestId, ...meta }, message);
  res.status(202).json({ ok: true });
}));
