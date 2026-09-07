import { Router } from "express";
import { z } from "zod";
import { logError } from "../../utils/systemLog.js";

export const clientLogsRouter = Router();

// Không authenticate: lỗi JS phía client (crash render, mất mạng, token hết hạn...) phải log được
// kể cả khi chưa đăng nhập hoặc access token đã chết - không thể đòi hỏi token hợp lệ mới cho ghi log lỗi.
const bodySchema = z.object({
  message: z.string().min(1).max(500),
  stack: z.string().max(4000).optional(),
  url: z.string().max(500).optional(),
  userEmail: z.string().max(200).optional(),
});

clientLogsRouter.post("/", (req, res) => {
  const p = bodySchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const { message, ...meta } = p.data;
  logError({ source: "frontend", ...meta }, message);
  res.status(202).json({ ok: true });
});
