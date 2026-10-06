import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { readPage } from "../../app/http/pagination.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as svc from "./invoice.service.js";

// Lịch sử xuất invoice + "Hàng chưa lên invoice". Cùng quyền với API xuất invoice (POST /trackings/invoice).
export const invoicesRouter = Router();
invoicesRouter.use(authenticateEither);

const firstPage = (size: number) => ({ page: 1, pageSize: size, skip: 0, take: size });

// ?month=YYYY-MM (bắt buộc, theo ngày đặt đơn giờ VN) [&q=][&unpacked=1][&page=&pageSize=] -> { items, pagination, totals }
invoicesRouter.get("/pending", authorize("trackings.list"), asyncHandler(async (req, res) => {
  const range = svc.monthRangeOr400(req.query.month);
  res.json(await svc.listNotInvoiced({
    ...range,
    q: String(req.query.q ?? "").trim() || undefined,
    unpacked: req.query.unpacked === "1",
  }, readPage(req, 50, 200) ?? firstPage(50)));
}));

invoicesRouter.get("/", authorize("trackings.list"), asyncHandler(async (req, res) => {
  res.json(await svc.listInvoiceHistory(readPage(req, 20, 100) ?? firstPage(20)));
}));

invoicesRouter.get("/:id", authorize("trackings.list"), asyncHandler(async (req, res) => {
  const id = parseOr400(z.string().uuid(), req.params.id);
  res.json(await svc.getInvoice(id));
}));
