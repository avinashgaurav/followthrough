import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CLI_TIMEOUT_MS, ClaudeCliLLM, getLLM, setLLM } from "./provider.ts";

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

describe("claude-cli timeout", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ft-cli-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  // A stand-in for the claude binary. `exec` so the kill reaches the sleeping
  // process itself and no child keeps the output pipe open.
  function fakeBin(body: string): string {
    const path = join(dir, "claude");
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  }

  test("defaults to 300 s", () => {
    expect(CLAUDE_CLI_TIMEOUT_MS).toBe(300_000);
  });

  test("kills a hung call once the timeout passes and says so", async () => {
    const llm = new ClaudeCliLLM({ timeoutMs: 200, bin: fakeBin("exec sleep 30") });
    const started = Date.now();
    await expect(llm.complete({ prompt: "hi" })).rejects.toThrow(/timed out after 0.2 s and was killed/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("a kill it did not cause is not reported as a timeout", async () => {
    const llm = new ClaudeCliLLM({ timeoutMs: 5_000, bin: fakeBin("kill -9 $$") });
    const err = await llm.complete({ prompt: "hi" }).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/without a JSON result/);
    expect(err?.message).not.toMatch(/timed out/);
  });

  test("a call that finishes inside the timeout returns its result", async () => {
    const out = JSON.stringify({ result: "ok", usage: { input_tokens: 3, output_tokens: 1 }, total_cost_usd: 0 });
    const llm = new ClaudeCliLLM({ timeoutMs: 5_000, bin: fakeBin(`cat >/dev/null; echo '${out}'`) });
    const r = await llm.complete({ prompt: "hi" });
    expect(r.text).toBe("ok");
    expect(r.tokensIn).toBe(3);
  });
});
