import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4500),
  DATA_DIR: z.string().default("./data"),
  BLOB_DIR: z.string().default("./data/blobs"),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  // Google Gemini (used when it is the only key set, or with LLM_PROVIDER=gemini).
  GEMINI_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  // Comma-separated domain terms to boost in Deepgram transcription accuracy
  // (e.g. "Karpenter,Kubernetes,Acme"). Empty → no boosting.
  DEEPGRAM_KEYTERMS: z.string().optional(),
  // Shared team password: any allowed-domain email + this value signs in
  // (auto-provisioned as a member). Unset → only per-user login codes work.
  ACCESS_PASSWORD: z.string().optional(),
  GITHUB_READ_TOKEN: z.string().optional(), // releases polling, read-only scope
  GITHUB_WRITE_TOKEN: z.string().optional(), // direct ticket creation, allowlisted repos only
  // owner/name of the GitHub repo whose releases are polled. Unset → poller off.
  RELEASE_REPO: z.string().optional(),
  // Comma-separated owner/name repos the tool may create issues in. Unset → none.
  WRITABLE_REPOS: z.string().optional(),
  // Comma-separated GitHub orgs the tool must never write to, even if allowlisted.
  BLOCKED_ORGS: z.string().optional(),
  // Comma-separated email domains allowed to hold accounts. Unset → any email.
  ALLOWED_EMAIL_DOMAINS: z.string().optional(),
  // Your company/product, used to frame every AI prompt.
  PRODUCT_NAME: z.string().optional(),
  PRODUCT_DESCRIPTION: z.string().optional(),
  DIGEST_WEBHOOK_URL: z.string().optional(),
  // Public read-only demo: blocks writes (except Ask), hides team/calendar data,
  // rate-limits Ask per IP, and turns off background jobs.
  DEMO_MODE: z.string().optional(),
  DEMO_ASK_PER_HOUR: z.coerce.number().int().positive().default(10),
  // Ask questions per hour across ALL visitors in demo mode.
  DEMO_ASK_GLOBAL_PER_HOUR: z.coerce.number().int().positive().default(200),
  // Hard daily cap on LLM spend (USD, UTC day). Unset → no cap, except
  // DEMO_MODE, which defaults to DEMO_DEFAULT_BUDGET_USD.
  LLM_DAILY_BUDGET_USD: z.coerce.number().positive().optional(),
  // How many reverse proxies append to X-Forwarded-For in front of this server.
  // The client IP is the entry that many hops from the RIGHT (entries further
  // left are client-supplied and spoofable). 0 → ignore XFF entirely.
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),
  // Trust cf-connecting-ip only when the server is reachable solely via Cloudflare.
  TRUST_CF_CONNECTING_IP: z.string().optional(),
  // Hosted multi-workspace mode: email sign-up via Supabase Auth, one Postgres
  // schema per workspace, a free meeting quota paid from this deployment's key.
  HOSTED_MODE: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  // Meetings each new workspace may process on this deployment's AI key.
  FREE_MEETINGS_PER_WORKSPACE: z.coerce.number().int().min(0).default(5),
  // Hard cap on sign-ups, so a launch spike cannot outgrow the AI budget.
  MAX_WORKSPACES: z.coerce.number().int().positive().default(300),
});

export const env = EnvSchema.parse(process.env);

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

function flag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function demoMode(): boolean {
  return flag(env.DEMO_MODE);
}

export function hostedMode(): boolean {
  return flag(env.HOSTED_MODE);
}

export function trustCfConnectingIp(): boolean {
  return flag(env.TRUST_CF_CONNECTING_IP);
}

/** A public demo always has a spend cap, even when none is configured. */
export const DEMO_DEFAULT_BUDGET_USD = 5;
/** Daily AI spend cap whenever a real AI key is set and LLM_DAILY_BUDGET_USD is not. */
export const DEFAULT_BUDGET_USD = 5;

/**
 * The daily AI spend cap in USD. LLM_DAILY_BUDGET_USD (a positive number) sets
 * it; raise it there if $5 a day is too little. With any AI key present there
 * is always a cap: a public deployment never runs uncapped by accident. Only a
 * keyless dev setup (MockLLM, which costs nothing) has none.
 */
export function llmDailyBudgetUsd(): number | undefined {
  if (env.LLM_DAILY_BUDGET_USD) return env.LLM_DAILY_BUDGET_USD;
  if (demoMode()) return DEMO_DEFAULT_BUDGET_USD;
  const anyKey =
    process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENROUTER_API_KEY ||
    env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY || env.OPENROUTER_API_KEY;
  return anyKey ? DEFAULT_BUDGET_USD : undefined;
}

/** Hosted mode: the signed-in workspace's own product, set per request. */
const productScope = new AsyncLocalStorage<{ name: string; description: string | null }>();

export function withProduct<T>(product: { name: string; description: string | null }, fn: () => Promise<T>): Promise<T> {
  return productScope.run(product, fn);
}

/** Who the AI is working for, e.g. "Acme, a payroll platform for SMBs". */
export function productLabel(): string {
  const ws = productScope.getStore();
  if (ws) {
    const desc = ws.description?.trim();
    return desc ? `${ws.name.trim()}, ${desc}` : ws.name.trim();
  }
  // The demo's fictional transcripts are about Tallyhall; keep the AI on-story.
  const name = env.PRODUCT_NAME?.trim() || (demoMode() ? "Tallyhall" : "our company");
  const desc =
    env.PRODUCT_DESCRIPTION?.trim() ||
    (demoMode() && !env.PRODUCT_NAME ? "an expense management platform for mid-size companies" : undefined);
  return desc ? `${name}, ${desc}` : name;
}

/** Repo key releases are stored under; "manual" when no GitHub repo is polled. */
export function releaseRepo(): string {
  return env.RELEASE_REPO?.trim() || "manual";
}

/** Allowed account email domains (lowercase). Empty → any domain. */
export function allowedEmailDomains(): string[] {
  // Hosted workspaces belong to different companies; one deployment-wide
  // domain lock would wrongly block their teammates.
  if (hostedMode()) return [];
  return csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
}

/**
 * Org safety (SPEC.md section 7): repos the tool may EVER create issues in,
 * from WRITABLE_REPOS. Orgs in BLOCKED_ORGS are refused even if allowlisted.
 * There is no runtime override; changing either needs a restart.
 */
export function writableRepos(): string[] {
  // One deployment's GitHub token must never write on behalf of other workspaces.
  if (hostedMode()) return [];
  return csv(env.WRITABLE_REPOS);
}

export function assertRepoWritable(repo: string): void {
  const normalized = repo.toLowerCase();
  const owner = normalized.split("/")[0] ?? "";
  if (csv(env.BLOCKED_ORGS).includes(owner)) {
    throw new Error(`Refusing to write to blocked org: ${repo}. See SPEC.md section 7.`);
  }
  if (!writableRepos().includes(normalized)) {
    throw new Error(`Repo not in writable allowlist: ${repo}`);
  }
}
