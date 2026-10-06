import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";

vi.mock("../../infrastructure/systemLog.js", () => ({ logError: vi.fn(), logWarn: vi.fn() }));

import { errorHandler } from "./errorHandler.js";
import { AppError } from "./AppError.js";
import { asyncHandler } from "../http/asyncHandler.js";
import { parseOr400 } from "../http/parse.js";

function app(fn: Parameters<typeof asyncHandler>[0]) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.requestId = "rid-1"; next(); });
  a.post("/", asyncHandler(fn));
  a.use(errorHandler);
  return a;
}

describe("errorHandler - error model thống nhất", () => {
  it("appErrorWithoutMessage_returnsOnlyErrorAndRequestId", async () => {
    const res = await request(app(() => { throw new AppError("INVALID_CREDENTIALS", 401); })).post("/");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "INVALID_CREDENTIALS", requestId: "rid-1" });
  });

  it("appErrorWithMessageAndDetail_returnsAllFields", async () => {
    const res = await request(app(async () => { throw new AppError("BUSY", 409, "Đang có bản backup chạy", { id: 1 }); })).post("/");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "BUSY", message: "Đang có bản backup chạy", detail: { id: 1 }, requestId: "rid-1" });
  });

  it("parseOr400_invalidBodyInSyncHandler_returns400BadRequestWithFlattenedDetail", async () => {
    const s = z.object({ name: z.string() });
    const res = await request(app((req, r) => { parseOr400(s, req.body, true); r.json({}); })).post("/").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("BAD_REQUEST");
    expect(res.body.message).toBeUndefined();
    expect(res.body.detail.fieldErrors.name).toBeDefined();
    expect(res.body.requestId).toBe("rid-1");
  });

  it("zodErrorThrown_returns400Validation", async () => {
    const res = await request(app(() => { z.object({ n: z.number() }).parse({}); })).post("/");
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: "VALIDATION", message: "Dữ liệu không hợp lệ", requestId: "rid-1" });
  });

  it("unknownError_returns500InternalWithoutLeakingMessage", async () => {
    const res = await request(app(async () => { throw new Error("boom"); })).post("/");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "INTERNAL", requestId: "rid-1" });
  });
});
