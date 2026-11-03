import type { Database } from "../db.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { releaseRepo } from "../config.ts";
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

export async function seed(): Promise<Seeded> {
  const db = await openTestDb();
  const t = nowIso();
  const addUser = db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const adminId = ulid();
  const aliceId = ulid();
  const bobId = ulid();
  await addUser.run(adminId, `admin-${adminId.slice(-5)}@tallyhall.com`, "Admin", "admin", t);
  await addUser.run(aliceId, `alice-${aliceId.slice(-5)}@tallyhall.com`, "Alice", "member", t);
  await addUser.run(bobId, `bob-${bobId.slice(-5)}@tallyhall.com`, "Bob", "member", t);

  const clientId = ulid();
  await db.query("INSERT INTO clients (id, name, created_at) VALUES (?, 'Acme', ?)").run(clientId, t);
  const meetingId = ulid();
  await db.query(
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

export async function makeInsight(s: Seeded, opts: InsightOpts = {}): Promise<string> {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  const body = opts.body ?? "Clients keep asking for this.";
  await s.db
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
export async function makeRelease(
  db: Database,
  opts: { tag: string; githubId: number; entries: ParsedEntry[]; publishedAt?: string },
): Promise<{ releaseId: string; entryIds: string[] }> {
  const releaseId = ulid();
  await db.query(
    `INSERT INTO releases (id, repo, github_release_id, tag_name, name, body_md, published_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(
    releaseId,
    releaseRepo(),
    opts.githubId,
    opts.tag,
    `Release ${opts.tag}`,
    opts.publishedAt ?? nowIso(),
    nowIso(),
  );
  const entryIds = await persistEntries(db, releaseId, opts.entries);
  return { releaseId, entryIds };
}

export function entry(over: Partial<ParsedEntry> = {}): ParsedEntry {
  return {
    section_type: "feature",
    title: "Dark mode for dashboards",
    body_md: "Dashboards now support dark mode across all pages, with a per-user toggle.",
    product_area: "Tallyhall",
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
