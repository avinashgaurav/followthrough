import { describe, expect, test } from "bun:test";
import { env } from "../config.ts";
import { openTestDb } from "../db.ts";
import { fetchReleases, upsertReleases, type FetchLike, type GitHubRelease } from "./poller.ts";
import { fixtureGitHubRelease } from "./test-helpers.ts";

interface Captured {
  url?: string;
  headers?: Record<string, string>;
}

function stubFetch(payload: unknown, captured: Captured = {}, status = 200): FetchLike {
  return async (url, init) => {
    captured.url = url;
    captured.headers = init?.headers;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
}

describe("fetchReleases", () => {
  test("GETs the releases endpoint with a User-Agent and no auth header by default", async () => {
    const captured: Captured = {};
    const saved = env.GITHUB_READ_TOKEN;
    env.GITHUB_READ_TOKEN = undefined;
    try {
      const list = await fetchReleases(stubFetch([fixtureGitHubRelease("v1.17.4", 17)], captured));
      expect(list).toHaveLength(1);
      expect(captured.url).toBe(`https://api.github.com/repos/${env.RELEASE_REPO}/releases?per_page=30`);
      expect(captured.headers?.["user-agent"]).toBe("followthrough-release-poller");
      expect(captured.headers?.authorization).toBeUndefined();
    } finally {
      env.GITHUB_READ_TOKEN = saved;
    }
  });

  test("sends a bearer token only when GITHUB_READ_TOKEN is set", async () => {
    const captured: Captured = {};
    const saved = env.GITHUB_READ_TOKEN;
    env.GITHUB_READ_TOKEN = "test-read-token";
    try {
      await fetchReleases(stubFetch([], captured));
      expect(captured.headers?.authorization).toBe("Bearer test-read-token");
    } finally {
      env.GITHUB_READ_TOKEN = saved;
    }
  });

  test("throws on a non-2xx response", async () => {
    await expect(fetchReleases(stubFetch({ message: "rate limited" }, {}, 403))).rejects.toThrow(
      /GitHub releases fetch failed \(403\)/,
    );
  });

  test("throws when the body is not an array", async () => {
    await expect(fetchReleases(stubFetch({ message: "nope" }))).rejects.toThrow(/expected a JSON array/);
  });
});

describe("upsertReleases", () => {
  const list: GitHubRelease[] = [
    fixtureGitHubRelease("v1.18.0", 180),
    fixtureGitHubRelease("v1.17.4", 174),
  ];

  test("inserts new releases, parses entries, and appends release.fetched events", () => {
    const db = openTestDb();
    const newIds = upsertReleases(db, list);
    expect(newIds).toHaveLength(2);

    const releases = db
      .query("SELECT id, repo, github_release_id, tag_name FROM releases ORDER BY github_release_id")
      .all() as Array<{ id: string; repo: string; github_release_id: number; tag_name: string }>;
    expect(releases).toHaveLength(2);
    expect(releases[0]!.repo).toBe(env.RELEASE_REPO);
    expect(releases.map((r) => r.tag_name).sort()).toEqual(["v1.17.4", "v1.18.0"]);

    // v1.18.0 parses to 4 entries, v1.17.4 to 1
    const entryCount = db.query("SELECT COUNT(*) AS n FROM release_entries").get() as { n: number };
    expect(entryCount.n).toBe(5);

    const events = db
      .query("SELECT entity_id, idempotency_key, actor_user_id FROM events WHERE event_type = 'release.fetched' ORDER BY id")
      .all() as Array<{ entity_id: string; idempotency_key: string; actor_user_id: string | null }>;
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.idempotency_key).sort()).toEqual([
      `release-${env.RELEASE_REPO}-174`,
      `release-${env.RELEASE_REPO}-180`,
    ]);
    expect(events[0]!.actor_user_id).toBeNull(); // system event
    expect(new Set(events.map((e) => e.entity_id))).toEqual(new Set(newIds));
  });

  test("is idempotent: a second pass with the same payload inserts nothing", () => {
    const db = openTestDb();
    const first = upsertReleases(db, list);
    expect(first).toHaveLength(2);

    const second = upsertReleases(db, list);
    expect(second).toHaveLength(0);

    expect((db.query("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT COUNT(*) AS n FROM release_entries").get() as { n: number }).n).toBe(5);
    expect(
      (db.query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'release.fetched'").get() as {
        n: number;
      }).n,
    ).toBe(2);
  });

  test("picks up only the releases not yet mirrored", () => {
    const db = openTestDb();
    upsertReleases(db, [list[0]!]);
    const newIds = upsertReleases(db, list);
    expect(newIds).toHaveLength(1);
    const tag = db
      .query("SELECT tag_name FROM releases WHERE id = ?")
      .get(newIds[0]!) as { tag_name: string };
    expect(tag.tag_name).toBe("v1.17.4");
  });

  test("skips draft releases", () => {
    const db = openTestDb();
    const draft = { ...fixtureGitHubRelease("v1.17.4", 999), draft: true };
    expect(upsertReleases(db, [draft])).toHaveLength(0);
    expect((db.query("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n).toBe(0);
  });
});
