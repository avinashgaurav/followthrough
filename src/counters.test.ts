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

  test("a free call settles its reservation back to $0", async () => {
    const db = await openTestDb();
    const ledger = dbSpendLedger(() => db);
    const now = () => new Date("2026-11-03T10:00:00Z");
    const b = new BudgetedLLM(new MockLLM().enqueue("hi"), 1, now, ledger);
    await b.complete({ prompt: "p" });
    expect(await ledger.spent("2026-11-03")).toBe(0);
  });

  test("concurrent calls cannot all pass the cap on the same remaining budget", async () => {
    const db = await openTestDb();
    const ledger = dbSpendLedger(() => db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let started = 0;
    const slow: LLM = {
      complete: async () => {
        started++;
        await gate; // hold every call open until all have tried to reserve
        return { text: "x", model: "m", tokensIn: 1, tokensOut: 1, costUsd: 0.6 };
      },
      completeJSON: async () => { throw new Error("unused"); },
    };
    const now = () => new Date("2026-11-03T10:00:00Z");
    const b = new BudgetedLLM(slow, 1, now, ledger, () => 0.6);
    const calls = [1, 2, 3].map((i) => b.complete({ prompt: String(i) }).then(() => "ok", (e) => e));
    await new Promise((r) => setTimeout(r, 50));
    release();
    const results = await Promise.all(calls);
    expect(started).toBe(1);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r instanceof LLMBudgetError)).toHaveLength(2);
    expect(await ledger.spent("2026-11-03")).toBeCloseTo(0.6);
  });

  test("a failed call keeps its reservation (usage unknown)", async () => {
    const db = await openTestDb();
    const ledger = dbSpendLedger(() => db);
    const failing: LLM = {
      complete: async () => { throw new Error("provider down"); },
      completeJSON: async () => { throw new Error("unused"); },
    };
    const now = () => new Date("2026-11-03T10:00:00Z");
    const b = new BudgetedLLM(failing, 1, now, ledger, () => 0.4);
    await expect(b.complete({ prompt: "x" })).rejects.toThrow("provider down");
    expect(await ledger.spent("2026-11-03")).toBeCloseTo(0.4);
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
