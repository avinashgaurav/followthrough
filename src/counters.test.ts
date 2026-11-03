import { describe, expect, test } from "bun:test";
import { openTestDb } from "./db.ts";
import { BudgetedLLM, LLMBudgetError, MockLLM, dbSpendLedger, type LLM } from "./llm/provider.ts";
import { askRateLimited } from "./insights/routes.ts";

describe("database-backed daily AI budget", () => {
  test("two instances share one tally, so the cap holds across serverless instances", async () => {
    const db = await openTestDb();
    const ledger = dbSpendLedger(() => db);
    const priced: LLM = {
      complete: async () => ({ text: "x", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0.6 }),
      completeJSON: async () => { throw new Error("unused"); },
    };
    const now = () => new Date("2026-11-03T10:00:00Z");
    const a = new BudgetedLLM(priced, 1, now, ledger);
    const b = new BudgetedLLM(priced, 1, now, ledger);
    await a.complete({ prompt: "1" });
    await b.complete({ prompt: "2" }); // 1.2 spent in total
    await expect(a.complete({ prompt: "3" })).rejects.toBeInstanceOf(LLMBudgetError);
    expect(await ledger.spent("2026-11-03")).toBeCloseTo(1.2);
    expect(await ledger.spent("2026-11-04")).toBe(0);
  });

  test("free calls are not written to the ledger", async () => {
    const db = await openTestDb();
    const ledger = dbSpendLedger(() => db);
    const b = new BudgetedLLM(new MockLLM().enqueue("hi"), 1, undefined, ledger);
    await b.complete({ prompt: "p" });
    expect(await db.query("SELECT COUNT(*) AS n FROM llm_spend").get()).toEqual({ n: 0 });
  });
});

describe("Ask rate limit", () => {
  test("allows up to the limit in the window, then refuses; old hits age out", async () => {
    const db = await openTestDb();
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    expect(await askRateLimited(db, "u1", 2, t0)).toBe(false);
    expect(await askRateLimited(db, "u1", 2, t0 + 1)).toBe(false);
    expect(await askRateLimited(db, "u1", 2, t0 + 2)).toBe(true);
    expect(await askRateLimited(db, "u2", 2, t0 + 3)).toBe(false); // per key
    expect(await askRateLimited(db, "u1", 2, t0 + 61 * 60 * 1000)).toBe(false); // an hour later
  });
});
