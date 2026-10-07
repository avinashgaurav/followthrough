import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4500),
  DATA_DIR: z.string().default("./data"),
  BLOB_DIR: z.string().default("./data/blobs"),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
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
});

export const env = EnvSchema.parse(process.env);

function csv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** Who the AI is working for, e.g. "Acme, a payroll platform for SMBs". */
export function productLabel(): string {
  const name = env.PRODUCT_NAME?.trim() || "our company";
  const desc = env.PRODUCT_DESCRIPTION?.trim();
  return desc ? `${name}, ${desc}` : name;
}

/** Repo key releases are stored under; "manual" when no GitHub repo is polled. */
export function releaseRepo(): string {
  return env.RELEASE_REPO?.trim() || "manual";
}

/** Allowed account email domains (lowercase). Empty → any domain. */
export function allowedEmailDomains(): string[] {
  return csv(env.ALLOWED_EMAIL_DOMAINS).map((d) => d.replace(/^@/, ""));
}

/**
 * Org safety (SPEC.md section 7): repos the tool may EVER create issues in,
 * from WRITABLE_REPOS. Orgs in BLOCKED_ORGS are refused even if allowlisted.
 * There is no runtime override; changing either needs a restart.
 */
export function writableRepos(): string[] {
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
