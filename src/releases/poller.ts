import type { Database } from "bun:sqlite";
import { env } from "../config.ts";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent } from "../events.ts";
import { parseRelease, persistEntries } from "./parser.ts";

/**
 * Release poller (SPEC.md section 6): READ-ONLY mirror of GitHub releases for
 * env.RELEASE_REPO (XYZ/XYZ) into the local releases table.
 *
 * Org safety: this module only ever issues GET requests. The read token, when
 * present, is a read-only scope token (SPEC.md section 17) and never leaves
 * the server.
 */

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name?: string | null;
  body?: string | null;
  published_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

/** Injectable fetch so tests never hit the network. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** Fetch the latest releases (newest first, GitHub default ordering). */
export async function fetchReleases(fetchImpl: FetchLike = fetch): Promise<GitHubRelease[]> {
  const url = `https://api.github.com/repos/${env.RELEASE_REPO}/releases?per_page=30`;
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "followthrough-release-poller",
    "x-github-api-version": "2022-11-28",
  };
  if (env.GITHUB_READ_TOKEN) headers.authorization = `Bearer ${env.GITHUB_READ_TOKEN}`;

  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub releases fetch failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error("GitHub releases fetch: expected a JSON array");
  return body as GitHubRelease[];
}

/**
 * Insert releases not yet mirrored, keyed by (repo, github_release_id).
 * Each new release is parsed into release_entries and recorded with a
 * release.fetched event under the idempotency key
 * "release-<repo>-<github_release_id>". Returns the new local release ids.
 */
export function upsertReleases(db: Database, list: GitHubRelease[]): string[] {
  const newIds: string[] = [];
  const exists = db.query("SELECT id FROM releases WHERE repo = ? AND github_release_id = ?");
  const insert = db.query(
    `INSERT INTO releases (id, repo, github_release_id, tag_name, name, body_md, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const rel of list) {
    if (rel.draft) continue; // unpublished drafts are not shipping evidence
    if (exists.get(env.RELEASE_REPO, rel.id)) continue;

    const id = ulid();
    const body = rel.body ?? "";
    const entries = parseRelease(body, rel.tag_name);
    const tx = db.transaction(() => {
      insert.run(
        id,
        env.RELEASE_REPO,
        rel.id,
        rel.tag_name,
        rel.name ?? null,
        body,
        rel.published_at ?? nowIso(),
        nowIso(),
      );
      persistEntries(db, id, entries);
      appendEvent(db, {
        actorUserId: null, // system
        entityType: "release",
        entityId: id,
        eventType: "release.fetched",
        payload: {
          repo: env.RELEASE_REPO,
          github_release_id: rel.id,
          tag_name: rel.tag_name,
          published_at: rel.published_at ?? null,
          entry_count: entries.length,
        },
        idempotencyKey: `release-${env.RELEASE_REPO}-${rel.id}`,
      });
    });
    tx();
    newIds.push(id);
  }
  return newIds;
}
