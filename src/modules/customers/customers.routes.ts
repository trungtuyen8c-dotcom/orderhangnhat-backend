import { Router } from "express";
import { z } from "zod";
import { v4 as uuid } from "uuid";
import { prisma } from "../../db.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { logAudit } from "../../utils/audit.js";

export const customersRouter = Router();
customersRouter.use(authenticate);

customersRouter.get("/", authorize("customers.list"), async (_req, res) => {
  const rows = await prisma.customer.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  res.json(rows);
});

const schema = z.object({
  name: z.string().min(1),
  fbZalo: z.string().optional(),
  phone: z.string().optional(),
  note: z.string().optional(),
});

customersRouter.post("/", authorize("customers.create"), async (req, res) => {
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const c = await prisma.customer.create({ data: { id: uuid(), ...parsed.data } });
  await logAudit({ actorId: req.user!.id, targetId: c.id, action: "customer.created" });
  res.status(201).json(c);
});

customersRouter.patch("/:id", authorize("customers.update"), async (req, res) => {
  const parsed = schema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "BAD_REQUEST" });
  const c = await prisma.customer.update({ where: { id: req.params.id }, data: parsed.data });
  res.json(c);
});
