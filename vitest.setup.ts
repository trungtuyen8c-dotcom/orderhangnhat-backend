import { vi } from "vitest";

// Không cho unit test đụng Redis thật (ioredis tự connect ngay khi import module) -
// mock 1 lần cho toàn bộ suite, test nào cần assert hành vi cache sẽ tự vi.mock lại riêng.
vi.mock("./src/redis.js", () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
}));
