import { Router } from "express";
import { z } from "zod";
import { parseOr400 } from "../../app/http/parse.js";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { getMe, listOnline } from "./me.service.js";
import { inAppNotifications } from "../notifications/notification.service.js";

export const meRouter = Router();

meRouter.get("/", authenticate, asyncHandler(async (req, res) => {
  res.json(await getMe(req.user!));
}));

meRouter.get("/online", authenticate, asyncHandler(async (_req, res) => {
  res.json(await listOnline());
}));

// Thông báo in-app (gửi qua job notification.send, xem modules/notifications).
const notifLimit = z.coerce.number().int().min(1).max(100).default(50);
meRouter.get("/notifications", authenticate, asyncHandler(async (req, res) => {
  const limit = parseOr400(notifLimit, req.query.limit);
  res.json(await inAppNotifications.list(req.user!, limit));
}));

const markReadSchema = z.object({ ids: z.array(z.string().min(1)).max(500).optional() });
meRouter.post("/notifications/read", authenticate, asyncHandler(async (req, res) => {
  const { ids } = parseOr400(markReadSchema, req.body ?? {});
  res.json(await inAppNotifications.markRead(req.user!, ids));
}));
