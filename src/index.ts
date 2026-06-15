import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { meRouter } from "./modules/me/me.routes.js";
import { ordersRouter } from "./modules/orders/orders.routes.js";

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
app.use("/api/auth", authRouter);
app.use("/api/me", meRouter);
app.use("/api/orders", ordersRouter);

// Error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "INTERNAL" });
});

app.listen(config.port, () => {
  console.log(`API listening on :${config.port}`);
});
