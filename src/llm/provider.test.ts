import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getLLM, setLLM } from "./provider.ts";

const saved = { ...process.env };

beforeEach(() => setLLM(null));

afterEach(() => {
  for (const k of ["LLM_PROVIDER", "NODE_ENV", "ALLOW_CLAUDE_CLI_EVAL"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setLLM(null);
});

describe("claude-cli eval route", () => {
  test("is refused when NODE_ENV=production", () => {
    process.env.LLM_PROVIDER = "claude-cli";
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_CLAUDE_CLI_EVAL;
    expect(() => getLLM()).toThrow(/eval-only route/);
  });

  test("is allowed in production only with ALLOW_CLAUDE_CLI_EVAL=1", () => {
    process.env.LLM_PROVIDER = "claude-cli";
    process.env.NODE_ENV = "production";
    process.env.ALLOW_CLAUDE_CLI_EVAL = "1";
    // Selecting the provider spawns nothing; only a call would.
    expect(() => getLLM()).not.toThrow();
  });
});
