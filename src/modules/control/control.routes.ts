import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../app/http/asyncHandler.js";
import { parseOr400 } from "../../app/http/parse.js";
import { authenticateEither } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import * as svc from "./control.service.js";

export const controlRouter = Router();
controlRouter.use(authenticateEither);

const actor = (req: Request): svc.Actor => ({ id: req.user!.id, requestId: req.requestId });

// ===== Kiện / carton: đối soát cân =====
controlRouter.get("/cartons", authorize("trackings.list"), asyncHandler(async (_req, res) => {
  res.json(await svc.listCartons());
}));

const cartonSchema = z.object({ code: z.string().min(1), declaredWeightKg: z.number().nonnegative().optional(), electronicsCount: z.number().int().nonnegative().optional(), packedDate: z.string().optional(), note: z.string().optional() });
controlRouter.post("/cartons", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(cartonSchema, req.body);
  res.status(201).json(await svc.createCarton(body, actor(req)));
}));

controlRouter.patch("/cartons/:id", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(cartonSchema.partial(), req.body);
  res.json(await svc.updateCarton(req.params.id, body));
}));

controlRouter.delete("/cartons/:id", authorize("trackings.update"), asyncHandler(async (req, res) => {
  res.json(await svc.deleteCarton(req.params.id, actor(req)));
}));

// Gán tracking vào kiện theo mã (dán nhiều mã, mỗi dòng 1 mã)
const assignSchema = z.object({ codes: z.array(z.string().min(1)).min(1) });
controlRouter.post("/cartons/:id/assign", authorize("trackings.update"), asyncHandler(async (req, res) => {
  const body = parseOr400(assignSchema, req.body);
  res.json(await svc.assignToCarton(req.params.id, body.codes));
}));

// ===== Tracking về VN chưa khớp đơn =====
controlRouter.get("/unmatched", authorize("trackings.list"), asyncHandler(async (_req, res) => {
  res.json(await svc.listUnmatched());
}));

// ===== Công nợ quá hạn / ngưỡng =====
controlRouter.get("/debt-config", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await svc.getDebtConfig());
}));
const debtCfgSchema = z.object({ thresholdVnd: z.number().nonnegative(), overdueDays: z.number().int().nonnegative() });
controlRouter.put("/debt-config", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  res.json(await svc.setDebtConfig(parseOr400(debtCfgSchema, req.body)));
}));

controlRouter.get("/overdue-debts", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await svc.overdueDebts());
}));

// ===== Hàng "Lưu kho" nằm quá lâu chưa ship =====
controlRouter.get("/storage-config", authorize("warehouse.weigh_vn"), asyncHandler(async (_req, res) => {
  res.json(await svc.getStorageConfig());
}));
const storageCfgSchema = z.object({ overdueDays: z.number().int().positive() });
controlRouter.put("/storage-config", authorize("system.manage_settings"), asyncHandler(async (req, res) => {
  res.json(await svc.setStorageConfig(parseOr400(storageCfgSchema, req.body)));
}));
// Đếm riêng cho Kho VN xem (role vn_warehouse không có quyền control.view để đọc /overview đầy đủ).
controlRouter.get("/storage-overdue-count", authorize("warehouse.weigh_vn"), asyncHandler(async (_req, res) => {
  res.json({ storageOverdue: await svc.storageOverdueCount() });
}));

// ===== Trung tâm kiểm soát: gom số đếm =====
controlRouter.get("/overview", authorize("orders.read"), asyncHandler(async (_req, res) => {
  res.json(await svc.overview());
}));
