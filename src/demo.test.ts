import { afterEach, describe, expect, test } from "bun:test";
import { DEMO_DEFAULT_BUDGET_USD, env, llmDailyBudgetUsd } from "./config.ts";
import { clientIp, demoBlocks } from "./demo.ts";
import { BudgetedLLM, LLMBudgetError, type LLM } from "./llm/provider.ts";

const saved = env.DEMO_MODE;
afterEach(() => {
  env.DEMO_MODE = saved;
});

describe("demoBlocks", () => {
  test("off by default: nothing is blocked", () => {
    env.DEMO_MODE = undefined;
    expect(demoBlocks("POST", "/api/meetings")).toBe(false);
    expect(demoBlocks("GET", "/api/users")).toBe(false);
  });

  test("on: writes blocked except Ask", () => {
    env.DEMO_MODE = "true";
    expect(demoBlocks("POST", "/api/meetings")).toBe(true);
    expect(demoBlocks("DELETE", "/api/meetings/abc")).toBe(true);
    expect(demoBlocks("POST", "/api/settings/access")).toBe(true);
    expect(demoBlocks("POST", "/api/auth/login")).toBe(true);
    expect(demoBlocks("POST", "/api/ask")).toBe(false);
    expect(demoBlocks("POST", "/api/ask/extra")).toBe(true);
  });

  test("on: reads allowed except team, calendar and watch-folder details", () => {
    env.DEMO_MODE = "1";
    expect(demoBlocks("GET", "/api/insights")).toBe(false);
    expect(demoBlocks("GET", "/api/metrics/overview")).toBe(false);
    expect(demoBlocks("GET", "/api/users")).toBe(true);
    expect(demoBlocks("GET", "/api/calendar/events")).toBe(true);
    expect(demoBlocks("GET", "/api/watchfolder/status")).toBe(true);
  });

  test("DEMO_MODE=false is off", () => {
    env.DEMO_MODE = "false";
    expect(demoBlocks("POST", "/api/meetings")).toBe(false);
  });
});

describe("clientIp", () => {
  const h = (headers: Record<string, string>) => new Request("http://x/", { headers });
  const savedHops = env.TRUSTED_PROXY_HOPS;
  const savedCf = env.TRUST_CF_CONNECTING_IP;
  afterEach(() => {
    env.TRUSTED_PROXY_HOPS = savedHops;
    env.TRUST_CF_CONNECTING_IP = savedCf;
  });

  test("one trusted proxy: the rightmost XFF entry, so a spoofed left entry is ignored", () => {
    env.TRUSTED_PROXY_HOPS = 1;
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(h({ "x-forwarded-for": "3.3.3.3" }))).toBe("3.3.3.3");
    expect(clientIp(h({}))).toBeNull();
  });

  test("two trusted proxies: second from the right", () => {
    env.TRUSTED_PROXY_HOPS = 2;
    expect(clientIp(h({ "x-forwarded-for": "6.6.6.6, 3.3.3.3, 10.0.0.1" }))).toBe("3.3.3.3");
    expect(clientIp(h({ "x-forwarded-for": "10.0.0.1" }))).toBeNull();
  });

  test("hops 0 ignores XFF entirely", () => {
    env.TRUSTED_PROXY_HOPS = 0;
    expect(clientIp(h({ "x-forwarded-for": "3.3.3.3" }))).toBeNull();
  });

  test("cf-connecting-ip only when explicitly trusted", () => {
    env.TRUSTED_PROXY_HOPS = 1;
    const req = () => h({ "cf-connecting-ip": "1.1.1.1", "x-forwarded-for": "2.2.2.2" });
    env.TRUST_CF_CONNECTING_IP = undefined;
    expect(clientIp(req())).toBe("2.2.2.2");
    env.TRUST_CF_CONNECTING_IP = "true";
    expect(clientIp(req())).toBe("1.1.1.1");
  });
});

describe("BudgetedLLM", () => {
  function fake(cost: number): LLM & { calls: number } {
    const usage = { model: "fake", tokensIn: 1, tokensOut: 1, costUsd: cost };
    const llm = {
      calls: 0,
      async complete() {
        llm.calls++;
        return { text: "ok", ...usage };
      },
      async completeJSON<T>() {
        llm.calls++;
        return { data: {} as T, ...usage };
      },
    };
    return llm;
  }

  test("refuses once the day's spend reaches the cap, without calling the provider", async () => {
    const inner = fake(0.6);
    const b = new BudgetedLLM(inner, 1, () => new Date("2026-10-09T10:00:00Z"));
    await b.complete({ prompt: "a" });
    await b.complete({ prompt: "b" }); // 0.6 < 1 before the call; overshoots to 1.2
    await expect(b.complete({ prompt: "c" })).rejects.toBeInstanceOf(LLMBudgetError);
    expect(inner.calls).toBe(2);
    expect(b.spentToday()).toBeCloseTo(1.2);
  });

  test("resets at the next UTC day", async () => {
    let now = new Date("2026-10-09T23:59:00Z");
    const inner = fake(5);
    const b = new BudgetedLLM(inner, 1, () => now);
    await b.complete({ prompt: "a" });
    await expect(b.completeJSON({ prompt: "b" } as never)).rejects.toBeInstanceOf(LLMBudgetError);
    now = new Date("2026-10-10T00:01:00Z");
    await b.complete({ prompt: "c" });
    expect(inner.calls).toBe(2);
  });

  test("unknown-model pricing ($0 reported) is charged conservatively so the cap still trips", async () => {
    const inner: LLM = {
      async complete() {
        return { text: "ok", model: "mystery", tokensIn: 100_000, tokensOut: 10_000, costUsd: 0 };
      },
      async completeJSON<T>() {
        return { data: {} as T, model: "mystery", tokensIn: 0, tokensOut: 0, costUsd: 0 };
      },
    };
    const b = new BudgetedLLM(inner, 1);
    await b.complete({ prompt: "a" }); // 100k*$15/M + 10k*$75/M = $2.25
    expect(b.spentToday()).toBeCloseTo(2.25);
    await expect(b.complete({ prompt: "b" })).rejects.toBeInstanceOf(LLMBudgetError);
  });
});

describe("llmDailyBudgetUsd", () => {
  test("demo mode always has a cap; explicit value wins; off otherwise", () => {
    const savedBudget = env.LLM_DAILY_BUDGET_USD;
    try {
      env.LLM_DAILY_BUDGET_USD = undefined;
      env.DEMO_MODE = undefined;
      expect(llmDailyBudgetUsd()).toBeUndefined();
      env.DEMO_MODE = "true";
      expect(llmDailyBudgetUsd()).toBe(DEMO_DEFAULT_BUDGET_USD);
      env.LLM_DAILY_BUDGET_USD = 20;
      expect(llmDailyBudgetUsd()).toBe(20);
    } finally {
      env.LLM_DAILY_BUDGET_USD = savedBudget;
    }
  });
});
