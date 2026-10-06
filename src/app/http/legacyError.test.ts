import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { handle, parseOr400, LegacyError } from "./legacyError.js";

function app(fn: Parameters<typeof handle>[0]) {
  const a = express();
  a.use(express.json());
  a.post("/", handle(fn));
  a.use((_e: unknown, _req: express.Request, res: express.Response, _n: express.NextFunction) => res.status(500).json({ error: "INTERNAL" }));
  return a;
}

describe("handle + LegacyError", () => {
  it("handle_legacyErrorWithoutMessage_returnsOnlyErrorCodeBody", async () => {
    const res = await request(app(() => { throw new LegacyError(401, "INVALID_CREDENTIALS"); })).post("/");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_CREDENTIALS" });
  });

  it("handle_legacyErrorWithMessage_returnsErrorAndMessageWithoutRequestId", async () => {
    const res = await request(app(async () => { throw new LegacyError(409, "BUSY", "Đang có bản backup chạy"); })).post("/");
    expect(res.body).toEqual({ error: "BUSY", message: "Đang có bản backup chạy" });
  });

  it("handle_otherError_delegatesToNextErrorHandler", async () => {
    const res = await request(app(async () => { throw new Error("boom"); })).post("/");
    expect(res.status).toBe(500);
  });

  it("parseOr400_invalidBodyWithDetail_returns400BadRequestWithFlattenedDetail", async () => {
    const s = z.object({ name: z.string() });
    const res = await request(app((req, r) => { parseOr400(s, req.body, true); r.json({}); })).post("/").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BAD_REQUEST");
    expect(res.body.detail.fieldErrors.name).toBeDefined();
  });
});
