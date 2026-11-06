// Run by the root `bun test`; excluded from the web tsconfig (no bun types there).
import { describe, expect, test } from "bun:test";
import { aiUnavailable, ApiError } from "./api";

describe("aiUnavailable", () => {
  test("true for a 503 that says the AI is busy or done for the day", () => {
    expect(aiUnavailable(new ApiError(503, "busy", { kind: "rate_limit" }))).toBe(true);
    expect(aiUnavailable(new ApiError(503, "tomorrow", { kind: "budget" }))).toBe(true);
  });
  test("false for anything else", () => {
    expect(aiUnavailable(new ApiError(503, "bad key", { kind: "ai_config" }))).toBe(false);
    expect(aiUnavailable(new ApiError(429, "slow down", { kind: "rate_limit" }))).toBe(false);
    expect(aiUnavailable(new ApiError(503, "no body"))).toBe(false);
    expect(aiUnavailable(new Error("plain"))).toBe(false);
  });
});
