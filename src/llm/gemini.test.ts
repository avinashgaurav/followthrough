import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { GeminiLLM, GEMINI_MODEL, LLMOutputError, geminiSelected, getLLM, setLLM } from "./provider.ts";

type Call = { url: string; init: RequestInit };

/** A fetch stub that replays the given responses in order and records each call. */
function stub(...responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("no stubbed response left");
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const answer = (text: string, usage = { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 3 }) => ({
  body: { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { text }] }, finishReason: "STOP" }], usageMetadata: usage, modelVersion: "gemini-3.6-flash-001" },
});
const noSleep = async () => {};

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LLM_PROVIDER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setLLM(null);
});

describe("GeminiLLM", () => {
  test("calls generateContent with the key header, system instruction and prompt", async () => {
    const { fetchImpl, calls } = stub(answer("Hello"));
    const r = await new GeminiLLM("k-123", fetchImpl, noSleep).complete({ system: "Be brief.", prompt: "Hi" });
    expect(r.text).toBe("Hello"); // thought parts are dropped
    expect(calls[0]!.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`);
    expect(new Headers(calls[0]!.init.headers).get("x-goog-api-key")).toBe("k-123");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.systemInstruction.parts[0].text).toBe("Be brief.");
    expect(body.contents[0].parts[0].text).toBe("Hi");
    expect(body.generationConfig.responseMimeType).toBeUndefined();
  });

  test("maps usage (thinking tokens count as output) and the model version", async () => {
    const { fetchImpl } = stub(answer("ok"));
    const r = await new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" });
    expect(r.tokensIn).toBe(12);
    expect(r.tokensOut).toBe(8);
    expect(r.model).toBe("gemini-3.6-flash-001");
  });

  test("ignores a Claude model name and uses the Gemini model", async () => {
    const { fetchImpl, calls } = stub(answer("ok"));
    await new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x", model: "claude-opus-4-8" });
    expect(calls[0]!.url).toContain(`/models/${GEMINI_MODEL}:`);
  });

  test("completeJSON asks for JSON, validates against the schema, and repairs once", async () => {
    const schema = z.object({ items: z.array(z.object({ title: z.string() })) });
    const { fetchImpl, calls } = stub(answer('{"items": [{"name": "wrong field"}]}'), answer('```json\n{"items": [{"title": "SSO"}]}\n```'));
    const r = await new GeminiLLM("k", fetchImpl, noSleep).completeJSON({ prompt: "extract", schema });
    expect(r.data).toEqual({ items: [{ title: "SSO" }] });
    expect(calls).toHaveLength(2);
    const first = JSON.parse(String(calls[0]!.init.body));
    expect(first.generationConfig.responseMimeType).toBe("application/json");
    expect(first.systemInstruction.parts[0].text).toContain('"title"');
    expect(JSON.parse(String(calls[1]!.init.body)).contents[0].parts[0].text).toContain("failed validation");
    expect(r.tokensIn).toBe(24); // both attempts are counted
  });

  test("completeJSON gives up with LLMOutputError after the repair round", async () => {
    const schema = z.object({ n: z.number() });
    const { fetchImpl } = stub(answer('{"n": "x"}'), answer('{"n": "y"}'));
    await expect(new GeminiLLM("k", fetchImpl, noSleep).completeJSON({ prompt: "p", schema })).rejects.toBeInstanceOf(LLMOutputError);
  });

  test("retries 429 and 5xx, then succeeds", async () => {
    const { fetchImpl, calls } = stub({ status: 429, body: "slow down" }, { status: 503, body: "busy" }, answer("done"));
    const r = await new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" });
    expect(r.text).toBe("done");
    expect(calls).toHaveLength(3);
  });

  test("does not retry a 400", async () => {
    const { fetchImpl, calls } = stub({ status: 400, body: "bad request" });
    await expect(new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" })).rejects.toThrow(/Gemini 400/);
    expect(calls).toHaveLength(1);
  });

  test("a blocked prompt is an output error", async () => {
    const { fetchImpl } = stub({ body: { promptFeedback: { blockReason: "SAFETY" } } });
    await expect(new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" })).rejects.toThrow(/blocked/);
  });
});

describe("provider selection", () => {
  test("Gemini is used when it is the only key", () => {
    process.env.GEMINI_API_KEY = "g";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.LLM_PROVIDER;
    expect(geminiSelected()).toBe(true);
    expect(getLLM()).toBeInstanceOf(GeminiLLM);
  });

  test("an Anthropic key wins unless LLM_PROVIDER=gemini", () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.ANTHROPIC_API_KEY = "a";
    delete process.env.LLM_PROVIDER;
    expect(geminiSelected()).toBe(false);
    process.env.LLM_PROVIDER = "gemini";
    expect(geminiSelected()).toBe(true);
  });
});

describe("Gemini rate limits", () => {
  const quota429 = (delay: string) => ({
    status: 429,
    body: { error: { code: 429, message: "quota", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }] } },
  });

  test("waits Google's retryDelay before retrying", async () => {
    const waits: number[] = [];
    const { fetchImpl } = stub(quota429("12s"), answer("ok"));
    const r = await new GeminiLLM("k", fetchImpl, async (ms) => void waits.push(ms)).complete({ prompt: "x" });
    expect(r.text).toBe("ok");
    expect(waits).toEqual([12_000]);
  });

  test("a long quota wait fails fast with LLMRateLimitError", async () => {
    const { fetchImpl, calls } = stub(quota429("3600s"));
    const { LLMRateLimitError } = await import("./provider.ts");
    await expect(new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" })).rejects.toBeInstanceOf(LLMRateLimitError);
    expect(calls).toHaveLength(1);
  });

  test("429 on every attempt ends in LLMRateLimitError", async () => {
    const { fetchImpl } = stub(quota429("1s"), quota429("1s"), quota429("1s"), quota429("1s"));
    const { LLMRateLimitError } = await import("./provider.ts");
    await expect(new GeminiLLM("k", fetchImpl, noSleep).complete({ prompt: "x" })).rejects.toBeInstanceOf(LLMRateLimitError);
  });
});
