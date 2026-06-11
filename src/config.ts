import { z } from "zod";

const EnvSchema = z.object({
  PORT: z.coerce.number().default(4500),
  DATA_DIR: z.string().default("./data"),
  BLOB_DIR: z.string().default("./data/blobs"),
  SESSION_TTL_HOURS: z.coerce.number().default(24 * 14),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  GITHUB_READ_TOKEN: z.string().optional(), // releases polling, read-only scope
  GITHUB_WRITE_TOKEN: z.string().optional(), // direct ticket creation, allowlisted repos only
  RELEASE_REPO: z.string().default("XYZ/XYZ"),
  DIGEST_WEBHOOK_URL: z.string().optional(),
});

export const env = EnvSchema.parse(process.env);

/**
 * Org safety (SPEC.md section 7): repos the tool may EVER create issues in.
 * The XYZ org is intentionally absent. Adding it requires an explicit
 * admin decision and a code change here; there is no runtime override.
 */
export const WRITABLE_REPO_ALLOWLIST: string[] = [
  "avinashgaurav/followthrough",
];

const BLOCKED_ORGS = ["xyz"];

export function assertRepoWritable(repo: string): void {
  const owner = repo.split("/")[0]?.toLowerCase() ?? "";
  if (BLOCKED_ORGS.includes(owner)) {
    throw new Error(`Refusing to write to blocked org: ${repo}. See SPEC.md section 7.`);
  }
  if (!WRITABLE_REPO_ALLOWLIST.includes(repo)) {
    throw new Error(`Repo not in writable allowlist: ${repo}`);
  }
}
