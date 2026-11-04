import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { tmpdir } from "node:os";
import { z } from "zod";
import { env, hostedMode, llmDailyBudgetUsd } from "../config.ts";
import { currentWorkspaceId } from "../hosted/tenancy.ts";
import { databaseUrl, getDb } from "../db.ts";

/**
 * LLM layer (SPEC.md sections 5, 10). Providers, in order of preference:
 * Anthropic direct (structured outputs via messages.parse() with Zod schemas;
 * the SDK retries 429/5xx), OpenRouter pinned to Claude models, and Google
 * Gemini. LLM_PROVIDER=gemini forces Gemini when several keys are set.
 */

/**
 * Gemini models to try, in order (GEMINI_MODELS, comma-separated). On a free
 * key each model has its own small daily quota, so when one is used up for the
 * day (or no longer offered) a call moves on to the next. GEMINI_MODEL, if
 * set, goes first.
 */
export const DEFAULT_GEMINI_MODELS = [
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
];

export function geminiModels(): string[] {
  const listed = (process.env.GEMINI_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  const base = listed.length ? listed : DEFAULT_GEMINI_MODELS;
  const first = process.env.GEMINI_MODEL?.trim();
  return [...new Set(first ? [first, ...base] : base)];
}

export const GEMINI_MODEL = geminiModels()[0]!;

/** Gemini is used when forced, or when it is the only provider key present. */
export function geminiSelected(): boolean {
  if (!process.env.GEMINI_API_KEY) return false;
  if (process.env.LLM_PROVIDER === "gemini") return true;
  return !process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY && process.env.LLM_PROVIDER !== "claude-cli";
}

export const DEFAULT_MODEL = process.env.LLM_MODEL ?? (geminiSelected() ? GEMINI_MODEL : "claude-opus-4-8");

// USD per million tokens
const PRICING: Record<string, { in: number; out: number }> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export interface LLMUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface CompleteOptions {
  system?: string;
  prompt: string;
  maxTokens?: number;
  model?: string;
}

export interface CompleteJSONOptions<T> extends CompleteOptions {
  schema: z.ZodType<T>;
}

export interface LLM {
  complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage>;
  completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage>;
}

function costUsd(model: string, tokensIn: number, tokensOut: number): number {
  const base = model.replace(/-\d{8}$/, "");
  const p = PRICING[base] ?? geminiPricing(base);
  if (!p) return 0;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export class LLMOutputError extends Error {}

/** Thrown before any provider call once the daily LLM_DAILY_BUDGET_USD is spent. */
export class LLMBudgetError extends Error {}

/** The provider kept answering 429 (rate limit or quota) after every retry. */
export class LLMRateLimitError extends Error {}

/** The provider refused the request (4xx) before generating anything: nothing was billed. */
export class LLMRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * True when the AI provider rejected this server's own credentials (bad,
 * revoked or missing API key): an operator problem, not something a retry or
 * the user can fix.
 */
export function isAIConfigError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const message = String((err as { message?: unknown }).message ?? "");
  const keyText = /API_KEY_INVALID|API key not valid|invalid[ _-]?(x-)?api[ _-]?key|authentication_error/i.test(message);
  // Anthropic SDK: AuthenticationError (401) always; PermissionDeniedError (403)
  // only when it is about the key (a 403 can also be a policy refusal).
  const name = err.constructor?.name ?? "";
  if (name === "AuthenticationError") return true;
  if (name === "PermissionDeniedError") return keyText;
  if (!(err instanceof LLMRequestError)) return false;
  if (err.status === 401) return true;
  return keyText;
}

/** The call ran out of its overall time (model fallback plus retries). */
export class LLMDeadlineError extends Error {}

/**
 * True when a failed call cannot have been billed: a rate limit or quota stop
 * (including every Gemini model exhausted), or any 4xx refusal (Anthropic's SDK
 * errors carry a status). Timeouts, 5xx after the request was sent, and
 * unusable output may have used tokens, so they are not refunded.
 */
export function wasNotBilled(err: unknown): boolean {
  if (err instanceof LLMRateLimitError || err instanceof LLMRequestError) return true;
  const status = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/** Google's suggested wait from a 429 body ("retryDelay": "41s"), in ms, or null. */
export function geminiRetryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** Longest single wait on a 429, so a call stays well inside a 300s function. */
const MAX_RETRY_WAIT_MS = 30_000;

/** Where the day's spend is kept. */
export interface SpendLedger {
  spent(day: string): Promise<number>;
  /** Atomically add `usd` to the day if the total stays within `cap`; false = refused. */
  reserve(day: string, usd: number, cap: number): Promise<boolean>;
  /** Settle up after a call: add the difference between real cost and reservation (may be negative). */
  adjust(day: string, usd: number): Promise<void>;
}

/** Process-memory ledger: one long-lived server, or no database configured. */
export function memorySpendLedger(): SpendLedger {
  const days = new Map<string, number>();
  return {
    async spent(day) {
      return days.get(day) ?? 0;
    },
    async reserve(day, usd, cap) {
      const cur = days.get(day) ?? 0;
      if (cur + usd > cap) return false;
      days.set(day, cur + usd);
      return true;
    },
    async adjust(day, usd) {
      days.set(day, Math.max(0, (days.get(day) ?? 0) + usd));
    },
  };
}

/**
 * The llm_spend table: one shared tally for every serverless instance. The
 * reservation is a single conditional UPDATE, so two instances can never both
 * pass the cap check on the same remaining budget.
 */
export function dbSpendLedger(
  db: () => import("../db.ts").Database,
  table: "llm_spend" | "control.llm_spend" = "llm_spend",
): SpendLedger {
  return {
    async spent(day) {
      const row = (await db().query(`SELECT usd FROM ${table} WHERE day = ?`).get(day)) as { usd: number } | null;
      return row?.usd ?? 0;
    },
    async reserve(day, usd, cap) {
      await db().query(`INSERT INTO ${table} (day, usd) VALUES (?, 0) ON CONFLICT (day) DO NOTHING`).run(day);
      const r = await db()
        .query(`UPDATE ${table} SET usd = usd + ?1 WHERE day = ?2 AND usd + ?1 <= ?3 RETURNING usd`)
        .run(usd, day, cap);
      return r.rows.length > 0;
    },
    async adjust(day, usd) {
      if (usd === 0) return;
      await db().query(`UPDATE ${table} SET usd = GREATEST(usd + ?1, 0) WHERE day = ?2`).run(usd, day);
    },
  };
}

/**
 * Hosted mode: the deployment-wide cap (control.llm_spend) plus each
 * workspace's own daily cap (control.llm_spend_ws), so one workspace cannot
 * spend everyone's budget. Both reservations are atomic conditional UPDATEs;
 * if the global one fails the workspace reservation is given back.
 */
export function hostedSpendLedger(db: () => import("../db.ts").Database, workspaceCapUsd: number): SpendLedger {
  const global = dbSpendLedger(db, "control.llm_spend");
  return {
    spent: global.spent,
    async reserve(day, usd, cap) {
      const ws = currentWorkspaceId();
      if (ws) {
        await db()
          .query("INSERT INTO control.llm_spend_ws (workspace_id, day, usd) VALUES (?, ?, 0) ON CONFLICT (workspace_id, day) DO NOTHING")
          .run(ws, day);
        const r = await db()
          .query(
            "UPDATE control.llm_spend_ws SET usd = usd + ?1 WHERE workspace_id = ?2 AND day = ?3 AND usd + ?1 <= ?4 RETURNING usd",
          )
          .run(usd, ws, day, workspaceCapUsd);
        if (r.rows.length === 0) return false;
      }
      const ok = await global.reserve(day, usd, cap);
      if (!ok && ws) {
        await db()
          .query("UPDATE control.llm_spend_ws SET usd = GREATEST(usd - ?1, 0) WHERE workspace_id = ?2 AND day = ?3")
          .run(usd, ws, day);
      }
      return ok;
    },
    async adjust(day, usd) {
      await global.adjust(day, usd);
      const ws = currentWorkspaceId();
      if (ws && usd !== 0) {
        await db()
          .query("UPDATE control.llm_spend_ws SET usd = GREATEST(usd + ?1, 0) WHERE workspace_id = ?2 AND day = ?3")
          .run(usd, ws, day);
      }
    },
  };
}

/** Conservative rate (USD per million tokens) for models without a known price. */
const FALLBACK_PRICE = { in: 15, out: 75 };

/** Output-token defaults the providers use when a call does not set maxTokens. */
export const DEFAULT_MAX_TOKENS = { text: 8192, json: 16000 } as const;
/** completeJSON may make a repair attempt (Gemini, OpenRouter): reserve for both. */
const JSON_ATTEMPTS = 2;

/**
 * The worst case a call can cost, reserved before it runs: the prompt (about 4
 * characters a token) plus the full output allowance (maxTokens, or the
 * provider default), times the attempts a JSON call may make, at the model's
 * price or the conservative fallback. Settling refunds the difference.
 */
export function estimateCostUsd(opts: CompleteOptions, kind: "text" | "json" = "text"): number {
  const model = (opts.model ?? DEFAULT_MODEL).replace(/-\d{8}$/, "");
  const p = PRICING[model] ?? geminiPricing(model) ?? FALLBACK_PRICE;
  const tokensIn = Math.ceil(((opts.system?.length ?? 0) + opts.prompt.length) / 4);
  const tokensOut = opts.maxTokens ?? DEFAULT_MAX_TOKENS[kind];
  const attempts = kind === "json" ? JSON_ATTEMPTS : 1;
  return ((tokensIn * p.in + tokensOut * p.out) * attempts) / 1_000_000;
}

/**
 * Hard daily spend cap around any LLM. Before each call it atomically reserves
 * an estimate (estimateCostUsd) against the cap and refuses if that would pass
 * it; after the call the reservation is settled to the reported cost, so a call
 * can overshoot by its own cost but concurrent calls cannot all slip through on
 * the same remaining budget. A call that fails keeps its reservation (its real
 * usage is unknown). With the database ledger the tally is shared across
 * serverless instances; the memory ledger resets on restart.
 */
export class BudgetedLLM implements LLM {
  private day = "";
  private spent = 0;

  constructor(
    private inner: LLM,
    private capUsd: number,
    private now: () => Date = () => new Date(),
    private ledger: SpendLedger = memorySpendLedger(),
    private estimate: (opts: CompleteOptions, kind: "text" | "json") => number = estimateCostUsd,
  ) {}

  spentToday(): number {
    this.roll();
    return this.spent;
  }

  private roll(): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }

  /** Unknown-model pricing reports $0; charge a conservative rate instead so the cap still trips. */
  private cost(r: LLMUsage): number {
    const tokens = r.tokensIn + r.tokensOut;
    return r.costUsd > 0 || tokens === 0
      ? r.costUsd
      : (r.tokensIn * FALLBACK_PRICE.in + r.tokensOut * FALLBACK_PRICE.out) / 1_000_000;
  }

  /** Ledger writes after the provider answered must never fail the call. */
  private async settle(day: string, usd: number): Promise<void> {
    try {
      await this.ledger.adjust(day, usd);
    } catch (err) {
      console.error("AI budget ledger update failed:", err);
    }
  }

  private async guarded<R extends LLMUsage>(opts: CompleteOptions, kind: "text" | "json", run: () => Promise<R>): Promise<R> {
    this.roll();
    const day = this.day;
    const reserved = this.estimate(opts, kind);
    if (!(await this.ledger.reserve(day, reserved, this.capUsd))) {
      throw new LLMBudgetError("Today's AI budget is used up. Try again tomorrow.");
    }
    let r: R;
    try {
      r = await run();
    } catch (err) {
      // Refused before generating (rate limit, quota, 4xx): give the reservation
      // back. Otherwise usage is unknown and the reservation stands.
      if (wasNotBilled(err)) await this.settle(day, -reserved);
      else this.spent += reserved;
      throw err;
    }
    const actual = this.cost(r);
    this.spent += actual;
    await this.settle(day, actual - reserved);
    return r;
  }

  complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    return this.guarded(opts, "text", () => this.inner.complete(opts));
  }

  completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    return this.guarded(opts, "json", () => this.inner.completeJSON(opts));
  }
}

class AnthropicLLM implements LLM {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 4 });
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    const model = opts.model ?? DEFAULT_MODEL;
    const response = await this.client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 8192,
      thinking: { type: "adaptive" },
      ...(opts.system
        ? { system: [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }] }
        : {}),
      messages: [{ role: "user", content: opts.prompt }],
    });
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      costUsd: costUsd(model, response.usage.input_tokens, response.usage.output_tokens),
    };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    const model = opts.model ?? DEFAULT_MODEL;
    const response = await this.client.messages.parse({
      model,
      max_tokens: opts.maxTokens ?? 16000,
      thinking: { type: "adaptive" },
      ...(opts.system
        ? { system: [{ type: "text" as const, text: opts.system, cache_control: { type: "ephemeral" as const } }] }
        : {}),
      messages: [{ role: "user", content: opts.prompt }],
      output_config: { format: zodOutputFormat(opts.schema) },
    });
    if (response.parsed_output == null) {
      throw new LLMOutputError(
        `Model returned unparseable output (stop_reason: ${response.stop_reason})`,
      );
    }
    return {
      data: response.parsed_output,
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      costUsd: costUsd(model, response.usage.input_tokens, response.usage.output_tokens),
    };
  }
}

/**
 * OpenRouter fallback (founder-supplied key). Constraints that keep the SPEC
 * privacy posture: requests are pinned to Anthropic Claude models only, and
 * provider.data_collection is set to deny so transcripts are not retained or
 * used for training. A direct ANTHROPIC_API_KEY always takes priority.
 */
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-4.8";

function extractJsonObject(text: string): string {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");
  const start = stripped.indexOf("{");
  if (start < 0) throw new LLMOutputError("No JSON object in model output");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
    } else if (ch === "\\") {
      escaped = inString;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return stripped.slice(start, i + 1);
      }
    }
  }
  throw new LLMOutputError("Unbalanced JSON object in model output");
}

class OpenRouterLLM implements LLM {
  constructor(private apiKey: string) {}

  private async chat(
    system: string | undefined,
    user: string,
    maxTokens: number,
    model: string,
  ): Promise<{ text: string; tokensIn: number; tokensOut: number; model: string }> {
    if (!model.startsWith("anthropic/")) {
      throw new Error(`OpenRouter model must be an Anthropic Claude model, got: ${model}`);
    }
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          provider: { data_collection: "deny" },
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            { role: "user", content: user },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`OpenRouter ${res.status}: ${await res.text()}`);
        continue;
      }
      if (!res.ok) throw new LLMRequestError(res.status, `OpenRouter ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        model?: string;
      };
      const text = body.choices?.[0]?.message?.content ?? "";
      return {
        text,
        tokensIn: body.usage?.prompt_tokens ?? 0,
        tokensOut: body.usage?.completion_tokens ?? 0,
        model: body.model ?? model,
      };
    }
    throw lastErr ?? new Error("OpenRouter request failed");
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    const model = opts.model ?? OPENROUTER_MODEL;
    const r = await this.chat(opts.system, opts.prompt, opts.maxTokens ?? 8192, model);
    const normalized = model.replace("anthropic/", "claude-").replace(/\./g, "-").replace("claude-claude", "claude");
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: costUsd(normalized, r.tokensIn, r.tokensOut) };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    const model = opts.model ?? OPENROUTER_MODEL;
    const jsonSchema = JSON.stringify(z.toJSONSchema(opts.schema as z.ZodType));
    const system = `${opts.system ?? ""}\n\nRespond with ONLY a single JSON object (no prose, no code fences) that validates against this JSON Schema:\n${jsonSchema}`;
    let tokensIn = 0;
    let tokensOut = 0;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\nYour previous response failed validation: ${lastError}. Return ONLY the corrected JSON object.`;
      const r = await this.chat(system, prompt, opts.maxTokens ?? 16000, model);
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      try {
        const data = opts.schema.parse(JSON.parse(extractJsonObject(r.text)));
        const normalized = model.replace("anthropic/", "claude-").replace(/\./g, "-");
        return { data, model: r.model, tokensIn, tokensOut, costUsd: costUsd(normalized, tokensIn, tokensOut) };
      } catch (err) {
        lastError = err instanceof Error ? err.message.slice(0, 600) : String(err);
      }
    }
    throw new LLMOutputError(`OpenRouter output failed schema validation: ${lastError}`);
  }
}

/**
 * Google Gemini over the REST generateContent endpoint (x-goog-api-key).
 * Structured output: JSON response mode, the Zod schema as JSON Schema in the
 * system instruction, Zod validation, and one repair round on a mismatch (the
 * same contract as OpenRouter above). Retries 429/5xx with backoff.
 *
 * Gemini prices are not hard-coded: set GEMINI_PRICE_IN_PER_M and
 * GEMINI_PRICE_OUT_PER_M (USD per million tokens) so the daily budget counts
 * real spend; without them the budget charges a conservative fallback rate.
 */
export function geminiPricing(model: string): { in: number; out: number } | null {
  if (!model.startsWith("gemini")) return null;
  // GEMINI_PRICES="gemini-3.6-flash=0.3/2.5,gemini-3.1-flash-lite=0.1/0.4" prices each model;
  // GEMINI_PRICE_IN_PER_M / GEMINI_PRICE_OUT_PER_M apply to any Gemini model not listed.
  for (const entry of (process.env.GEMINI_PRICES ?? "").split(",")) {
    const m = /^\s*([^=\s]+)\s*=\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(entry);
    if (m && m[1] === model && Number(m[2]) > 0 && Number(m[3]) > 0) return { in: Number(m[2]), out: Number(m[3]) };
  }
  const pin = Number(process.env.GEMINI_PRICE_IN_PER_M);
  const pout = Number(process.env.GEMINI_PRICE_OUT_PER_M);
  if (pin > 0 && pout > 0) return { in: pin, out: pout };
  return GEMINI_DEFAULT_PRICES.find((d) => d.match.test(model))?.price ?? null;
}

/**
 * Built-in budget prices (USD per million tokens) for the Gemini families in
 * the default model list. They are conservative estimates set at or above
 * flash-tier list pricing, not quotes: set GEMINI_PRICES to your real rates.
 * Other Gemini models (e.g. pro) get the budget's conservative fallback rate.
 */
export const GEMINI_DEFAULT_PRICES: Array<{ match: RegExp; price: { in: number; out: number } }> = [
  { match: /^gemini-.*flash-lite/, price: { in: 0.25, out: 1.5 } },
  { match: /^gemini-.*flash/, price: { in: 0.5, out: 3 } },
];

/** A model that cannot serve calls today: its daily quota is spent, or it is gone. */
class GeminiModelUnavailable extends Error {}

/** Models whose daily quota is spent, shared across instances (app_settings). */
export interface GeminiExhaustionStore {
  load(day: string): Promise<string[]>;
  mark(model: string, day: string): Promise<void>;
}

export function dbGeminiExhaustionStore(db: () => import("../db.ts").Database): GeminiExhaustionStore {
  return {
    async load(day) {
      const rows = (await db()
        .query("SELECT key FROM app_settings WHERE key LIKE 'gemini_exhausted:%' AND value = ?")
        .all(day)) as Array<{ key: string }>;
      return rows.map((r) => r.key.slice("gemini_exhausted:".length));
    },
    async mark(model, day) {
      await db()
        .query(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        )
        .run(`gemini_exhausted:${model}`, day, new Date().toISOString());
    },
  };
}

/** Per-instance memory of exhausted models: model -> the UTC day it ran out. */
const exhaustedToday = new Map<string, string>();
/** Models that turned out to reject thinkingConfig. */
const noThinkingConfig = new Set<string>();

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
  promptFeedback?: { blockReason?: string };
}

export class GeminiLLM implements LLM {
  private models: string[];
  private now: () => Date;
  private exhausted: Map<string, string>;
  private store: GeminiExhaustionStore | null;
  private loadedDay = "";
  private deadlineMs: number;

  constructor(
    private apiKey: string,
    private fetchImpl: typeof fetch = fetch,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    opts: {
      models?: string[];
      now?: () => Date;
      exhausted?: Map<string, string>;
      store?: GeminiExhaustionStore | null;
      /** Overall time for one call, across model fallback and retries (default 240s, under the 300s function limit). */
      deadlineMs?: number;
    } = {},
  ) {
    this.deadlineMs = opts.deadlineMs ?? 240_000;
    this.models = opts.models ?? geminiModels();
    this.now = opts.now ?? (() => new Date());
    this.exhausted = opts.exhausted ?? exhaustedToday;
    this.store = opts.store === undefined ? (databaseUrl() ? dbGeminiExhaustionStore(getDb) : null) : opts.store;
  }

  private today(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** Models to try for this call: a requested Gemini model first, then the configured order. */
  private candidates(requested?: string): string[] {
    const first = requested && requested.startsWith("gemini") ? [requested] : [];
    return [...new Set([...first, ...this.models])];
  }

  /** Try each model in order, skipping ones exhausted today; a model that runs out moves on. */
  private async generate(
    system: string | undefined,
    user: string,
    maxTokens: number,
    requested: string | undefined,
    json: boolean,
  ): Promise<{ text: string; tokensIn: number; tokensOut: number; model: string; called: string }> {
    const day = this.today();
    if (this.store && this.loadedDay !== day) {
      this.loadedDay = day;
      try {
        for (const m of await this.store.load(day)) this.exhausted.set(m, day);
      } catch (err) {
        console.warn("could not read exhausted Gemini models:", err);
      }
    }
    const deadline = Date.now() + this.deadlineMs;
    for (const model of this.candidates(requested)) {
      if (this.exhausted.get(model) === day) continue;
      if (Date.now() >= deadline) throw new LLMDeadlineError("Gemini call ran out of time trying models");
      try {
        return { ...(await this.generateOn(model, system, user, maxTokens, json, deadline)), called: model };
      } catch (err) {
        if (!(err instanceof GeminiModelUnavailable)) throw err;
        console.warn(`Gemini ${model} unavailable today, trying the next model: ${err.message}`);
        this.exhausted.set(model, day);
        await this.store?.mark(model, day).catch((e) => console.warn("could not record exhausted Gemini model:", e));
      }
    }
    throw new LLMRateLimitError("Every configured Gemini model has used its daily quota. Try again tomorrow, or add billing to the Google project.");
  }

  /** One model, with retries for brief rate limits and server errors. */
  private async generateOn(
    model: string,
    system: string | undefined,
    user: string,
    maxTokens: number,
    json: boolean,
    deadline = Date.now() + this.deadlineMs,
  ): Promise<{ text: string; tokensIn: number; tokensOut: number; model: string }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const body = (thinking: boolean) =>
      JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          ...(json ? { responseMimeType: "application/json" } : {}),
          // Gemini 3 models think by default; minimal keeps output tokens (and cost) down.
          ...(thinking ? { thinkingConfig: { thinkingLevel: "minimal" } } : {}),
        },
      });
    let thinking = model.startsWith("gemini-3") && !noThinkingConfig.has(model);
    let lastErr: Error | null = null;
    let wait = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const pause = wait || 1500 * 2 ** attempt;
        if (Date.now() + pause >= deadline) break; // no time left for another try
        await this.sleep(pause);
      }
      wait = 0;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "POST",
          headers: { "x-goog-api-key": this.apiKey, "content-type": "application/json" },
          body: body(thinking),
          signal: AbortSignal.timeout(Math.min(120_000, remaining)),
        });
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (res.status === 429) {
        const text = await res.text();
        // A per-day quota will not clear today: move to the next model.
        if (/PerDay/i.test(text)) throw new GeminiModelUnavailable(`daily quota used (${model})`);
        const hinted = geminiRetryDelayMs(text);
        if (hinted !== null && hinted > MAX_RETRY_WAIT_MS) {
          throw new LLMRateLimitError(`Gemini quota or rate limit reached (retry in ${Math.round(hinted / 1000)}s)`);
        }
        wait = hinted ?? 0;
        lastErr = new LLMRateLimitError(`Gemini rate limit: ${text.slice(0, 300)}`);
        continue;
      }
      if (res.status === 404) throw new GeminiModelUnavailable(`not available (${model}): ${(await res.text()).slice(0, 200)}`);
      if (res.status >= 500) {
        lastErr = new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
        continue;
      }
      if (res.status === 400 && thinking) {
        const text = await res.text();
        if (/thinking/i.test(text)) {
          // This model does not take thinkingConfig: remember, and resend without it.
          noThinkingConfig.add(model);
          thinking = false;
          attempt--;
          continue;
        }
        throw new LLMRequestError(400, `Gemini 400: ${text.slice(0, 400)}`);
      }
      if (!res.ok) throw new LLMRequestError(res.status, `Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const data = (await res.json()) as GeminiResponse;
      if (data.promptFeedback?.blockReason) {
        throw new LLMOutputError(`Gemini blocked the prompt: ${data.promptFeedback.blockReason}`);
      }
      const cand = data.candidates?.[0];
      // Thinking models may return thought parts; only the answer text counts.
      const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      if (!text && cand?.finishReason && cand.finishReason !== "STOP") {
        throw new LLMOutputError(`Gemini returned no text (finishReason: ${cand.finishReason})`);
      }
      const u = data.usageMetadata ?? {};
      return {
        text,
        tokensIn: u.promptTokenCount ?? 0,
        tokensOut: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        model: data.modelVersion ?? model,
      };
    }
    throw lastErr ?? new LLMDeadlineError(`Gemini ${model} ran out of time`);
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    const r = await this.generate(opts.system, opts.prompt, opts.maxTokens ?? 8192, opts.model, false);
    // Priced by the model that actually answered (after any fallback).
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: costUsd(r.called, r.tokensIn, r.tokensOut) };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    const { $schema: _meta, ...schema } = z.toJSONSchema(opts.schema as z.ZodType) as Record<string, unknown>;
    void _meta;
    const system = `${opts.system ?? ""}\n\nRespond with ONLY a single JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = attempt === 0
        ? opts.prompt
        : `${opts.prompt}\n\nYour previous response failed validation: ${lastError}. Return ONLY the corrected JSON object.`;
      const r = await this.generate(system, prompt, opts.maxTokens ?? 16000, opts.model, true);
      tokensIn += r.tokensIn;
      tokensOut += r.tokensOut;
      // Each attempt is priced by its own model (a repair may land on a fallback).
      cost += costUsd(r.called, r.tokensIn, r.tokensOut);
      try {
        const data = opts.schema.parse(JSON.parse(extractJsonObject(r.text)));
        return { data, model: r.model, tokensIn, tokensOut, costUsd: cost };
      } catch (err) {
        lastError = err instanceof Error ? err.message.slice(0, 600) : String(err);
      }
    }
    throw new LLMOutputError(`Gemini output failed schema validation: ${lastError}`);
  }
}

/**
 * Evaluation-only provider: LLM_PROVIDER=claude-cli routes calls through the
 * locally installed, logged-in Claude Code CLI (`claude -p`) instead of the
 * API, so the eval harness can run on a subscription without an API key. It is
 * never selected unless that variable is set, and it is not a production path.
 *
 * Kept as close to a plain Messages call as the CLI allows: the app's own
 * system prompt (--system-prompt replaces Claude Code's), no tools, no MCP, no
 * hooks/CLAUDE.md/skills/plugins (--safe-mode), no settings files, no session
 * persistence, and the Zod schema enforced via --json-schema. Known
 * differences: the CLI prepends a short preamble and an environment block to
 * the system prompt, enforces structured output through its own tool rather
 * than output_config.format, and max_tokens cannot be set. costUsd is the CLI's
 * own list-price estimate (it includes prompt-cache writes).
 */
export const claudeCliCallLog: Array<{
  model: string;
  ms: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  numTurns: number;
}> = [];

/** A CLI call that runs longer than this is killed and fails, so a hung login prompt cannot stall a run. */
export const CLAUDE_CLI_TIMEOUT_MS = 300_000;

export class ClaudeCliLLM implements LLM {
  private readonly timeoutMs: number;
  private readonly bin: string | undefined;

  /** Test seam: a shorter timeout and a stand-in binary let the kill path be tested without a real 300 s wait. */
  constructor(opts: { timeoutMs?: number; bin?: string } = {}) {
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
    this.bin = opts.bin;
  }

  private async run(
    system: string | undefined,
    prompt: string,
    model: string,
    jsonSchema?: unknown,
  ): Promise<{ text: string; structured: unknown } & LLMUsage> {
    const args = [
      "-p",
      "--output-format", "json",
      "--system-prompt", system ?? "",
      "--tools", "",
      "--model", model,
      "--effort", "high",
      "--no-session-persistence",
      "--setting-sources", "",
      "--strict-mcp-config",
      "--safe-mode",
      "--disable-slash-commands",
      ...(jsonSchema ? ["--json-schema", JSON.stringify(jsonSchema)] : []),
    ];
    const started = Date.now();
    // Prompt on stdin (not argv) and a neutral cwd so no project context is discovered.
    // CLAUDE_CLI_BIN overrides the binary (default `claude` on PATH).
    const proc = Bun.spawn([this.bin ?? process.env.CLAUDE_CLI_BIN ?? "claude", ...args], {
      cwd: tmpdir(),
      stdin: new Blob([prompt]),
      stdout: "pipe",
      stderr: "pipe",
    });
    // Our own timer, so a kill is reported as a timeout only when we caused it.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, this.timeoutMs);
    let out: string, err: string, code: number;
    try {
      [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (timedOut) {
      throw new Error(`claude CLI timed out after ${this.timeoutMs / 1000} s and was killed`);
    }
    let r: {
      is_error?: boolean;
      subtype?: string;
      result?: string;
      api_error_status?: unknown;
      structured_output?: unknown;
      total_cost_usd?: number;
      num_turns?: number;
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      modelUsage?: Record<string, unknown>;
    };
    try {
      r = JSON.parse(out);
    } catch {
      throw new Error(`claude CLI exited ${code} without a JSON result: ${(err || out).slice(0, 500)}`);
    }
    if (r.is_error) {
      throw new Error(
        `claude CLI error (${r.subtype}, api status ${String(r.api_error_status)}): ${String(r.result ?? "").slice(0, 500)}`,
      );
    }
    const u = r.usage ?? {};
    const answered = Object.keys(r.modelUsage ?? {}).join("+") || model;
    const tokensIn = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const entry = {
      model: answered,
      ms: Date.now() - started,
      tokensIn,
      tokensOut: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      costUsd: r.total_cost_usd ?? 0,
      numTurns: r.num_turns ?? 0,
    };
    claudeCliCallLog.push(entry);
    return {
      text: String(r.result ?? ""),
      structured: r.structured_output,
      model: answered,
      tokensIn,
      tokensOut: entry.tokensOut,
      costUsd: entry.costUsd,
    };
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    const r = await this.run(opts.system, opts.prompt, opts.model ?? DEFAULT_MODEL);
    return { text: r.text, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    // The CLI's validator does not resolve the draft-2020-12 meta-schema URI.
    const { $schema: _meta, ...schema } = z.toJSONSchema(opts.schema as z.ZodType) as Record<string, unknown>;
    void _meta;
    const r = await this.run(opts.system, opts.prompt, opts.model ?? DEFAULT_MODEL, schema);
    const parsed = opts.schema.safeParse(r.structured);
    if (!parsed.success) {
      throw new LLMOutputError(`claude CLI structured output failed schema validation: ${parsed.error.message.slice(0, 600)}`);
    }
    return { data: parsed.data, model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costUsd: r.costUsd };
  }
}

/** Deterministic mock for tests and keyless dev. Queue responses in order of use. */
export class MockLLM implements LLM {
  private queue: unknown[] = [];
  calls: Array<{ system?: string; prompt: string }> = [];

  enqueue(response: unknown): this {
    this.queue.push(response);
    return this;
  }

  private next(): unknown {
    if (this.queue.length === 0) throw new Error("MockLLM queue empty");
    return this.queue.shift();
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    this.calls.push({ system: opts.system, prompt: opts.prompt });
    return { text: String(this.next()), model: "mock", tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    this.calls.push({ system: opts.system, prompt: opts.prompt });
    const data = opts.schema.parse(this.next());
    return { data, model: "mock", tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }
}

let instance: LLM | null = null;

/** Test seam: inject a MockLLM. */
export function setLLM(llm: LLM | null): void {
  instance = llm;
}

export function getLLM(): LLM {
  if (instance) return instance;
  if (process.env.LLM_PROVIDER === "claude-cli") {
    // Opt-in eval route only; see ClaudeCliLLM. Never chosen implicitly, and
    // refused in production unless explicitly allowed for an eval run.
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_CLAUDE_CLI_EVAL !== "1") {
      throw new Error(
        "LLM_PROVIDER=claude-cli is an eval-only route and is refused when NODE_ENV=production. " +
          "Set ALLOW_CLAUDE_CLI_EVAL=1 to override for an eval run.",
      );
    }
    console.warn("LLM_PROVIDER=claude-cli: routing through the local Claude Code CLI (evals only).");
    instance = new ClaudeCliLLM();
  } else if (geminiSelected()) {
    instance = new GeminiLLM((process.env.GEMINI_API_KEY ?? env.GEMINI_API_KEY)!);
  } else if (env.ANTHROPIC_API_KEY) {
    instance = new AnthropicLLM(env.ANTHROPIC_API_KEY);
  } else if (env.OPENROUTER_API_KEY) {
    console.warn("Using OpenRouter (Claude models only, data_collection=deny). Prefer a direct ANTHROPIC_API_KEY.");
    instance = new OpenRouterLLM(env.OPENROUTER_API_KEY);
  } else {
    console.warn("No LLM key set; using MockLLM (dev only)");
    instance = new MockLLM();
  }
  const cap = llmDailyBudgetUsd();
  if (cap) {
    // Shared across serverless instances when a database is configured.
    // Hosted: one cap across every workspace, kept in the control registry.
    const ledger = !databaseUrl()
      ? memorySpendLedger()
      : hostedMode()
        ? hostedSpendLedger(getDb, env.WORKSPACE_DAILY_BUDGET_USD)
        : dbSpendLedger(getDb);
    instance = new BudgetedLLM(instance, cap, undefined, ledger);
  }
  return instance;
}
