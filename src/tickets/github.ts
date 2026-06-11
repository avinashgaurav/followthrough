import { assertRepoWritable } from "../config.ts";

/**
 * GitHub issue creation (SPEC.md section 7). This is the ONLY code path that
 * writes to GitHub. assertRepoWritable runs inside createIssue itself, not
 * just in the route, so no caller can reach the GitHub API write without
 * passing the org-safety allowlist (XYZ is blocked there).
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CreatedIssue {
  url: string;
  number: number;
}

export class GitHubApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function createIssue(
  repo: string,
  title: string,
  body: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<CreatedIssue> {
  assertRepoWritable(repo); // defense in depth; routes also check before calling
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title, body }),
  });
  if (res.status !== 201) {
    const detail = await res.text().catch(() => "");
    throw new GitHubApiError(res.status, `GitHub issue creation failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { html_url: string; number: number };
  return { url: data.html_url, number: data.number };
}
