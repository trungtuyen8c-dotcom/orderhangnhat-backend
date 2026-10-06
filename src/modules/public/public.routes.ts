import { Router } from "express";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { AppError } from "../../app/errors/AppError.js";
import { findOrderIdByToken, getPublicOrder, getPublicOrderById } from "./public.service.js";
import { openOrderStream, publicOrderHub } from "./public.events.js";

export const publicRouter = Router();

publicRouter.get("/orders/:token", asyncHandler(async (req, res) => {
  res.json(await getPublicOrder(req.params.token));
}));

// SSE: payload giống hệt GET trên, đẩy lại khi đơn/tracking đổi. Nginx cần proxy_buffering off cho path này.
publicRouter.get("/orders/:token/events", asyncHandler(async (req, res) => {
  const orderId = await findOrderIdByToken(req.params.token);
  if (!orderId) throw new AppError("NOT_FOUND", 404);
  const initial = await getPublicOrderById(orderId);
  if (!initial) throw new AppError("NOT_FOUND", 404);
  if (!openOrderStream(req, res, { hub: publicOrderHub, orderId, initial })) {
    throw new AppError("RATE_LIMITED", 429, "Quá nhiều kết nối theo dõi đơn từ địa chỉ này");
  }
}));
