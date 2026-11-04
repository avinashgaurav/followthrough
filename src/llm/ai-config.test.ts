import { describe, expect, test } from "bun:test";
import { isAIConfigError, LLMRequestError } from "./provider.ts";
import { route } from "../router.ts";
import { handleApi } from "../app.ts";

describe("AI provider key rejected", () => {
  test("recognised from our request errors and SDK auth errors, not from other failures", () => {
    expect(isAIConfigError(new LLMRequestError(400, 'Gemini 400: {"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}'))).toBe(true);
    expect(isAIConfigError(new LLMRequestError(401, "OpenRouter 401: no auth"))).toBe(true);
    class AuthenticationError extends Error {}
    expect(isAIConfigError(new AuthenticationError("401 invalid x-api-key"))).toBe(true);
    expect(isAIConfigError(new LLMRequestError(400, "Gemini 400: bad schema"))).toBe(false);
    expect(isAIConfigError(Object.assign(new Error("forbidden"), { status: 403 }))).toBe(false);
  });

  test("the API answers 503 with a clear message instead of a generic failure", async () => {
    route("GET", "/api/__test/ai-key", "public", async () => {
      throw new LLMRequestError(400, "Gemini 400: API key not valid. Please pass a valid API key.");
    });
    const res = await handleApi(new Request("http://localhost/api/__test/ai-key"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; kind: string };
    expect(body.kind).toBe("ai_config");
    expect(body.error).toContain("AI isn't configured");
  });
});
