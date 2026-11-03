import { describe, expect, test } from "bun:test";
import {
  BudgetedLLM,
  DEFAULT_MAX_TOKENS,
  GeminiLLM,
  LLMDeadlineError,
  LLMOutputError,
  LLMRateLimitError,
  LLMRequestError,
  estimateCostUsd,
  geminiPricing,
  memorySpendLedger,
  type LLM,
  type SpendLedger,
} from "./provider.ts";

const DAY = "2026-11-04";
const now = () => new Date(`${DAY}T10:00:00Z`);
const failing = (err: unknown): LLM => ({
  complete: async () => { throw err; },
  completeJSON: async () => { throw err; },
});

describe("a failed call's reservation", () => {
  const refunded: Array<[string, unknown]> = [
    ["rate limit / every model exhausted", new LLMRateLimitError("quota")],
    ["a 4xx refusal", new LLMRequestError(400, "bad request")],
    ["an SDK error with a 4xx status", Object.assign(new Error("anthropic 429"), { status: 429 })],
  ];
  for (const [what, err] of refunded) {
    test(`is refunded for ${what}`, async () => {
      const ledger = memorySpendLedger();
      const b = new BudgetedLLM(failing(err), 1, now, ledger, () => 0.4);
      await expect(b.complete({ prompt: "x" })).rejects.toBe(err);
      expect(await ledger.spent(DAY)).toBe(0);
    });
  }

  const kept: Array<[string, unknown]> = [
    ["a 5xx after the request was sent", new Error("Gemini 503: overloaded")],
    ["a timeout", new LLMDeadlineError("ran out of time")],
    ["unusable output (tokens were used)", new LLMOutputError("failed schema validation")],
  ];
  for (const [what, err] of kept) {
    test(`is kept for ${what}`, async () => {
      const ledger = memorySpendLedger();
      const b = new BudgetedLLM(failing(err), 1, now, ledger, () => 0.4);
      await expect(b.complete({ prompt: "x" })).rejects.toBe(err);
      expect(await ledger.spent(DAY)).toBeCloseTo(0.4);
    });
  }
});

describe("worst-case reservation", () => {
  test("a JSON call reserves the full default output allowance for two attempts", () => {
    process.env.GEMINI_PRICES = "gemini-test-model=1/10";
    try {
      const text = estimateCostUsd({ prompt: "", model: "gemini-test-model" }, "text");
      const json = estimateCostUsd({ prompt: "", model: "gemini-test-model" }, "json");
      expect(text).toBeCloseTo((DEFAULT_MAX_TOKENS.text * 10) / 1e6);
      expect(json).toBeCloseTo((DEFAULT_MAX_TOKENS.json * 10 * 2) / 1e6);
      expect(estimateCostUsd({ prompt: "", model: "gemini-test-model", maxTokens: 100 }, "json")).toBeCloseTo((100 * 10 * 2) / 1e6);
    } finally {
      delete process.env.GEMINI_PRICES;
    }
  });

  test("settling refunds the difference to the real cost", async () => {
    const ledger = memorySpendLedger();
    const cheap: LLM = {
      complete: async () => ({ text: "x", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0.05 }),
      completeJSON: async () => { throw new Error("unused"); },
    };
    await new BudgetedLLM(cheap, 1, now, ledger, () => 0.9).complete({ prompt: "x" });
    expect(await ledger.spent(DAY)).toBeCloseTo(0.05);
  });

  test("a ledger failure while settling never fails a call that already succeeded", async () => {
    const base = memorySpendLedger();
    const broken: SpendLedger = { ...base, adjust: async () => { throw new Error("db down"); } };
    const ok: LLM = {
      complete: async () => ({ text: "paid answer", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0.01 }),
      completeJSON: async () => { throw new Error("unused"); },
    };
    const r = await new BudgetedLLM(ok, 1, now, broken, () => 0.1).complete({ prompt: "x" });
    expect(r.text).toBe("paid answer");
  });
});

describe("Gemini default prices", () => {
  test("flash and flash-lite get built-in conservative prices; GEMINI_PRICES overrides", () => {
    expect(geminiPricing("gemini-3.6-flash")).toEqual({ in: 0.5, out: 3 });
    expect(geminiPricing("gemini-3.1-flash-lite")).toEqual({ in: 0.25, out: 1.5 });
    expect(geminiPricing("gemini-flash-lite-latest")).toEqual({ in: 0.25, out: 1.5 });
    expect(geminiPricing("gemini-3.1-pro-preview")).toBeNull(); // not flash: conservative fallback
    process.env.GEMINI_PRICES = "gemini-3.6-flash=0.3/2.5";
    try {
      expect(geminiPricing("gemini-3.6-flash")).toEqual({ in: 0.3, out: 2.5 });
    } finally {
      delete process.env.GEMINI_PRICES;
    }
  });
});

describe("Gemini overall deadline", () => {
  test("model fallback and retries stop at the deadline", async () => {
    let calls = 0;
    const slow429 = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({ error: { code: 503 } }), { status: 503 });
    }) as unknown as typeof fetch;
    const llm = new GeminiLLM("k", slow429, async () => {}, {
      models: ["gemini-a", "gemini-b"],
      exhausted: new Map(),
      store: null,
      deadlineMs: 50,
    });
    const err = await llm.complete({ prompt: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(calls).toBeLessThanOrEqual(3); // stopped early instead of 4 retries x 2 models
  });
});
