import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../config.ts";

/**
 * LLM layer (SPEC.md sections 5, 10): Anthropic direct, single provider for
 * client-confidential transcripts. Structured outputs via messages.parse()
 * with Zod schemas; the SDK validates and retries 429/5xx automatically.
 */

export const DEFAULT_MODEL = process.env.LLM_MODEL ?? "claude-opus-4-8";

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
  const p = PRICING[base];
  if (!p) return 0;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}

export class LLMOutputError extends Error {}

/** Thrown before any provider call once the daily LLM_DAILY_BUDGET_USD is spent. */
export class LLMBudgetError extends Error {}

/**
 * Hard daily spend cap around any LLM. Checks before each call and records the
 * reported cost after it, so one in-flight call can overshoot by its own cost.
 * In-memory per process: a restart resets the day's tally.
 */
export class BudgetedLLM implements LLM {
  private day = "";
  private spent = 0;

  constructor(
    private inner: LLM,
    private capUsd: number,
    private now: () => Date = () => new Date(),
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

  private check(): void {
    this.roll();
    if (this.spent >= this.capUsd) {
      throw new LLMBudgetError("Today's AI budget is used up. Try again tomorrow.");
    }
  }

  async complete(opts: CompleteOptions): Promise<{ text: string } & LLMUsage> {
    this.check();
    const r = await this.inner.complete(opts);
    this.spent += r.costUsd;
    return r;
  }

  async completeJSON<T>(opts: CompleteJSONOptions<T>): Promise<{ data: T } & LLMUsage> {
    this.check();
    const r = await this.inner.completeJSON(opts);
    this.spent += r.costUsd;
    return r;
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
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
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
  if (env.ANTHROPIC_API_KEY) {
    instance = new AnthropicLLM(env.ANTHROPIC_API_KEY);
  } else if (env.OPENROUTER_API_KEY) {
    console.warn("Using OpenRouter (Claude models only, data_collection=deny). Prefer a direct ANTHROPIC_API_KEY.");
    instance = new OpenRouterLLM(env.OPENROUTER_API_KEY);
  } else {
    console.warn("No LLM key set; using MockLLM (dev only)");
    instance = new MockLLM();
  }
  if (env.LLM_DAILY_BUDGET_USD) instance = new BudgetedLLM(instance, env.LLM_DAILY_BUDGET_USD);
  return instance;
}
