import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { env } from "../config.ts";
import { persistEntries, type ParsedEntry } from "./parser.ts";
import type { GitHubRelease } from "./poller.ts";

export interface Seeded {
  db: Database;
  admin: { id: string; role: "admin" };
  alice: { id: string; role: "member" };
  bob: { id: string; role: "member" };
  clientId: string;
  meetingId: string;
}

export function seed(): Seeded {
  const db = openTestDb();
  const t = nowIso();
  const addUser = db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const adminId = ulid();
  const aliceId = ulid();
  const bobId = ulid();
  addUser.run(adminId, `admin-${adminId.slice(-5)}@xyz.com`, "Admin", "admin", t);
  addUser.run(aliceId, `alice-${aliceId.slice(-5)}@xyz.com`, "Alice", "member", t);
  addUser.run(bobId, `bob-${bobId.slice(-5)}@xyz.com`, "Bob", "member", t);

  const clientId = ulid();
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, 'Acme', ?)").run(clientId, t);
  const meetingId = ulid();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, created_at) VALUES (?, ?, 1, '2026-05-01', ?)",
  ).run(meetingId, clientId, t);

  return {
    db,
    admin: { id: adminId, role: "admin" },
    alice: { id: aliceId, role: "member" },
    bob: { id: bobId, role: "member" },
    clientId,
    meetingId,
  };
}

export interface InsightOpts {
  state?: string;
  track?: string | null;
  assignee?: string | null;
  title?: string;
  body?: string;
  createdAt?: string;
}

export function makeInsight(s: Seeded, opts: InsightOpts = {}): string {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  const body = opts.body ?? "Clients keep asking for this.";
  s.db
    .query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, track, title, body_original, body_current,
                             state, assignee_user_id, created_at, updated_at)
       VALUES (?, ?, ?, 'feature_request', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      s.meetingId,
      s.clientId,
      opts.track === undefined ? "engineering" : opts.track,
      opts.title ?? "Test insight",
      body,
      body,
      opts.state ?? "finalized",
      opts.assignee === undefined ? null : opts.assignee,
      t,
      t,
    );
  return id;
}

/** Insert a release row plus its entries; returns ids. */
export function makeRelease(
  db: Database,
  opts: { tag: string; githubId: number; entries: ParsedEntry[]; publishedAt?: string },
): { releaseId: string; entryIds: string[] } {
  const releaseId = ulid();
  db.query(
    `INSERT INTO releases (id, repo, github_release_id, tag_name, name, body_md, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(
    releaseId,
    env.RELEASE_REPO,
    opts.githubId,
    opts.tag,
    `Release ${opts.tag}`,
    opts.publishedAt ?? nowIso(),
    nowIso(),
  );
  const entryIds = persistEntries(db, releaseId, opts.entries);
  return { releaseId, entryIds };
}

export function entry(over: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    section_type: "feature",
    title: "Dark mode for dashboards",
    body_md: "Dashboards now support dark mode across all pages, with a per-user toggle.",
    product_area: "XYZ",
    pr_refs: [],
    flags: [],
    ...over,
  };
}

export function fixtureGitHubRelease(tag: string, githubId: number): GitHubRelease {
  const f = JSON.parse(
    readFileSync(join(import.meta.dir, "fixtures", `${tag}.json`), "utf8"),
  ) as { body: string; tagName: string };
  return {
    id: githubId,
    tag_name: f.tagName,
    name: `Release ${f.tagName}`,
    body: f.body,
    published_at: "2026-06-01T00:00:00.000Z",
    draft: false,
    prerelease: false,
  };
}
