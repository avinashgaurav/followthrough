import { describe, expect, test } from "bun:test";
import { dispatch, route } from "./router.ts";
import { LLMBudgetError, LLMRateLimitError } from "./llm/provider.ts";

// Public routes skip the session lookup, so these need no database. Async like
// every real handler: the router catches rejections, not synchronous throws.
route("GET", "/__test/ai-busy", "public", async () => {
  throw new LLMRateLimitError("Gemini rate limit: raw provider text");
});
route("GET", "/__test/ai-daily", "public", async () => {
  throw new LLMRateLimitError("Every configured Gemini model has used its daily quota.", { daily: true });
});
route("GET", "/__test/ai-budget", "public", async () => {
  throw new LLMBudgetError("Today's AI budget is used up. Try again tomorrow.");
});

async function hit(path: string): Promise<{ status: number; body: { error: string; kind: string } }> {
  const res = (await dispatch(new Request(`http://x${path}`)))!;
  return { status: res.status, body: (await res.json()) as { error: string; kind: string } };
}

describe("AI unavailable answers", () => {
  test("a brief rate limit says try again in a few minutes, never the provider's text", async () => {
    const r = await hit("/__test/ai-busy");
    expect(r.status).toBe(503);
    expect(r.body.kind).toBe("rate_limit");
    expect(r.body.error).toBe("The AI is busy right now. Try again in a few minutes.");
  });

  test("a spent daily quota says tomorrow, like the budget", async () => {
    const r = await hit("/__test/ai-daily");
    expect(r.status).toBe(503);
    expect(r.body.kind).toBe("budget");
    expect(r.body.error).toContain("Try again tomorrow");
    expect(r.body.error).not.toContain("Gemini");
  });

  test("the daily budget says tomorrow", async () => {
    const r = await hit("/__test/ai-budget");
    expect(r.status).toBe(503);
    expect(r.body.kind).toBe("budget");
    expect(r.body.error).toBe("The AI has done all it can for today. Try again tomorrow.");
  });
});
