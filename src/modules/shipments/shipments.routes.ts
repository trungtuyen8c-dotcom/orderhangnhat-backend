import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { minio, BUCKET } from "../../minio.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const shipmentsRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
shipmentsRouter.use(authenticate);

shipmentsRouter.get("/", authorize("shipments.list"), async (_req, res) => {
  const rows = await prisma.shipment.findMany({
    orderBy: { id: "desc" }, take: 100,
    include: { _count: { select: { trackings: true, documents: true } } },
  });
  res.json(rows);
});

const createSchema = z.object({ code: z.string().min(1) });
shipmentsRouter.post("/", authorize("shipments.create"), async (req, res) => {
  const p = createSchema.safeParse(req.body);
  if (!p.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const s = await prisma.shipment.create({ data: { id: uuid(), code: p.data.code } });
  await logAudit({ actorId: req.user!.id, targetId: s.id, action: "shipment.created" });
  res.status(201).json(s);
});

// Upload chứng từ GA (invoice/packing/ingredient/purchase_invoice/tax) qua backend -> MinIO
shipmentsRouter.post("/documents", authorize("shipments.upload_doc"), upload.single("file"), async (req, res) => {
  const file = req.file;
  const { type, orderId, shipmentId } = req.body as { type?: string; orderId?: string; shipmentId?: string };
  if (!file || !type) return res.status(400).json({ error: "BAD_REQUEST" });

  const key = `documents/${type}/${uuid()}-${file.originalname}`;
  await minio.putObject(BUCKET, key, file.buffer, file.size, { "Content-Type": file.mimetype });
  const doc = await prisma.document.create({
    data: { id: uuid(), type, objectKey: key, orderId: orderId || null, shipmentId: shipmentId || null, uploadedBy: req.user!.id },
  });
  await logAudit({ actorId: req.user!.id, targetId: doc.id, action: "document.uploaded", metadata: { type } });
  res.status(201).json(doc);
});

shipmentsRouter.get("/documents", authorize("shipments.list"), async (req, res) => {
  const where: any = {};
  if (req.query.orderId) where.orderId = String(req.query.orderId);
  if (req.query.shipmentId) where.shipmentId = String(req.query.shipmentId);
  const rows = await prisma.document.findMany({ where, orderBy: { createdAt: "desc" }, take: 200 });
  res.json(rows);
});

// Tải file: backend stream từ MinIO (không expose MinIO ra ngoài)
shipmentsRouter.get("/documents/:id/download", authorize("shipments.list"), async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.status(404).json({ error: "NOT_FOUND" });
  try {
    const stream = await minio.getObject(BUCKET, doc.objectKey);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.objectKey.split("/").pop()}"`);
    stream.pipe(res);
  } catch {
    res.status(500).json({ error: "DOWNLOAD_FAILED" });
  }
});
