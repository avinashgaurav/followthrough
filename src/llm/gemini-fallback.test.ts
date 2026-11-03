import { afterEach, describe, expect, test } from "bun:test";
import { openTestDb } from "../db.ts";
import { GeminiLLM, LLMRateLimitError, dbGeminiExhaustionStore, geminiModels, geminiPricing } from "./provider.ts";

const MODELS = ["m-flash", "m-lite", "m-last"].map((m) => `gemini-3-${m}`) as [string, string, string];
const perDay429 = () =>
  new Response(JSON.stringify({ error: { code: 429, details: [{ violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { retryDelay: "40000s" }] } }), { status: 429 });
const brief429 = () => new Response(JSON.stringify({ error: { code: 429, details: [{ retryDelay: "2s" }] } }), { status: 429 });
const ok = (text = "fine", usage = { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 }) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: usage }));

/** Routes each request by model name to a queue of responses; records the model order. */
function byModel(plan: Record<string, Array<() => Response>>) {
  const order: string[] = [];
  const bodies: any[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const model = decodeURIComponent(/models\/([^:]+):/.exec(url)![1]!);
    order.push(model);
    bodies.push(JSON.parse(String(init.body)));
    const next = plan[model]?.shift();
    if (!next) throw new Error(`unexpected call to ${model}`);
    return next();
  }) as unknown as typeof fetch;
  return { fetchImpl, order, bodies };
}
const noSleep = async () => {};
const day = (iso: string) => () => new Date(iso);

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["GEMINI_MODELS", "GEMINI_MODEL", "GEMINI_PRICES", "GEMINI_PRICE_IN_PER_M", "GEMINI_PRICE_OUT_PER_M"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("Gemini model fallback", () => {
  test("a per-day quota 429 moves the call to the next model, in order", async () => {
    const { fetchImpl, order } = byModel({ [MODELS[0]!]: [perDay429], [MODELS[1]!]: [perDay429], [MODELS[2]!]: [() => ok("from last")] });
    const llm = new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store: null, now: day("2026-11-03T10:00:00Z") });
    const r = await llm.complete({ prompt: "x" });
    expect(r.text).toBe("from last");
    expect(order).toEqual(MODELS);
  });

  test("an exhausted model is skipped for the rest of the UTC day, then tried again", async () => {
    let now = new Date("2026-11-03T10:00:00Z");
    const exhausted = new Map<string, string>();
    const { fetchImpl, order } = byModel({
      [MODELS[0]!]: [perDay429, () => ok("back tomorrow")],
      [MODELS[1]!]: [() => ok("a"), () => ok("b")],
    });
    const llm = new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted, store: null, now: () => now });
    await llm.complete({ prompt: "1" });
    await llm.complete({ prompt: "2" }); // m-flash is not called again today
    now = new Date("2026-11-04T00:05:00Z");
    const r = await llm.complete({ prompt: "3" });
    expect(r.text).toBe("back tomorrow");
    expect(order).toEqual([MODELS[0], MODELS[1], MODELS[1], MODELS[0]]);
  });

  test("other instances learn the exhausted model from the database", async () => {
    const db = await openTestDb();
    const store = dbGeminiExhaustionStore(() => db);
    const now = day("2026-11-03T10:00:00Z");
    const a = byModel({ [MODELS[0]!]: [perDay429], [MODELS[1]!]: [() => ok()] });
    await new GeminiLLM("k", a.fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store, now }).complete({ prompt: "x" });
    const b = byModel({ [MODELS[1]!]: [() => ok("skipped straight to lite")] });
    const r = await new GeminiLLM("k", b.fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store, now }).complete({ prompt: "y" });
    expect(r.text).toBe("skipped straight to lite");
    expect(b.order).toEqual([MODELS[1]]);
  });

  test("a 404 (model no longer offered) also moves on", async () => {
    const { fetchImpl, order } = byModel({ [MODELS[0]!]: [() => new Response('{"error":{"code":404,"message":"no longer available"}}', { status: 404 })], [MODELS[1]!]: [() => ok()] });
    await new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store: null }).complete({ prompt: "x" });
    expect(order).toEqual([MODELS[0], MODELS[1]]);
  });

  test("a brief 429 retries the same model instead of falling back", async () => {
    const { fetchImpl, order } = byModel({ [MODELS[0]!]: [brief429, () => ok()] });
    await new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store: null }).complete({ prompt: "x" });
    expect(order).toEqual([MODELS[0], MODELS[0]]);
  });

  test("every model exhausted ends in LLMRateLimitError", async () => {
    const { fetchImpl } = byModel({ [MODELS[0]!]: [perDay429], [MODELS[1]!]: [perDay429], [MODELS[2]!]: [perDay429] });
    const llm = new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store: null });
    await expect(llm.complete({ prompt: "x" })).rejects.toBeInstanceOf(LLMRateLimitError);
  });
});

describe("Gemini pricing by model", () => {
  test("each call is priced by the model that answered; unknown models report $0 (the budget then charges the conservative rate)", async () => {
    process.env.GEMINI_PRICES = `${MODELS[0]}=1/2,${MODELS[1]}=0.1/0.4`;
    const { fetchImpl } = byModel({ [MODELS[0]!]: [perDay429], [MODELS[1]!]: [() => ok()], [MODELS[2]!]: [] });
    const llm = new GeminiLLM("k", fetchImpl, noSleep, { models: MODELS, exhausted: new Map(), store: null });
    const r = await llm.complete({ prompt: "x" }); // 1M in + 1M out on the lite model
    expect(r.costUsd).toBeCloseTo(0.5);
    expect(geminiPricing(MODELS[0]!)).toEqual({ in: 1, out: 2 });
    expect(geminiPricing("gemini-unknown")).toBeNull();
    process.env.GEMINI_PRICE_IN_PER_M = "3";
    process.env.GEMINI_PRICE_OUT_PER_M = "4";
    expect(geminiPricing("gemini-unknown")).toEqual({ in: 3, out: 4 });
    expect(geminiPricing(MODELS[1]!)).toEqual({ in: 0.1, out: 0.4 }); // the per-model price wins
  });
});

describe("Gemini thinkingConfig", () => {
  test("sent as minimal to gemini-3 models only, and dropped for a model that rejects it", async () => {
    const plan = {
      "gemini-3-x": [() => new Response('{"error":{"code":400,"message":"thinking_level is not supported"}}', { status: 400 }), () => ok()],
      "gemini-flash-lite-latest": [() => ok()],
    };
    const { fetchImpl, bodies } = byModel(plan);
    const llm = new GeminiLLM("k", fetchImpl, noSleep, { models: ["gemini-3-x"], exhausted: new Map(), store: null });
    await llm.complete({ prompt: "x" });
    expect(bodies[0].generationConfig.thinkingConfig).toEqual({ thinkingLevel: "minimal" });
    expect(bodies[1].generationConfig.thinkingConfig).toBeUndefined();
    const lite = new GeminiLLM("k", fetchImpl, noSleep, { models: ["gemini-flash-lite-latest"], exhausted: new Map(), store: null });
    await lite.complete({ prompt: "y" });
    expect(bodies[2].generationConfig.thinkingConfig).toBeUndefined();
  });

  test("GEMINI_MODELS sets the order; GEMINI_MODEL goes first", () => {
    process.env.GEMINI_MODELS = "a,b";
    delete process.env.GEMINI_MODEL;
    expect(geminiModels()).toEqual(["a", "b"]);
    process.env.GEMINI_MODEL = "b";
    expect(geminiModels()).toEqual(["b", "a"]);
    delete process.env.GEMINI_MODELS;
    delete process.env.GEMINI_MODEL;
    expect(geminiModels()[0]).toBe("gemini-3.6-flash");
  });
});
