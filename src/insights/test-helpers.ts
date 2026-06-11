import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import type { Actor } from "./service.ts";

export interface Seeded {
  db: Database;
  admin: Actor;
  alice: Actor;
  bob: Actor;
  acme: string;
  globex: string;
  meetingAcme1: string;
  meetingAcme2: string;
  meetingGlobex1: string;
}

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function seed(): Seeded {
  const db = openTestDb();
  const t = nowIso();

  const mkUser = (name: string, role: "admin" | "member"): string => {
    const id = ulid();
    db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      `${name}-${id.slice(-4)}@xyz.com`,
      name,
      role,
      t,
    );
    return id;
  };
  const mkClient = (name: string): string => {
    const id = ulid();
    db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(id, name, t);
    return id;
  };
  const adminId = mkUser("admin", "admin");
  const aliceId = mkUser("alice", "member");
  const bobId = mkUser("bob", "member");
  const acme = mkClient("Acme");
  const globex = mkClient("Globex");

  const mkMeeting = (clientId: string, seq: number, date: string): string => {
    const id = ulid();
    db.query(
      "INSERT INTO meetings (id, client_id, seq, meeting_date, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, clientId, seq, date, adminId, t);
    return id;
  };

  return {
    db,
    admin: { id: adminId, role: "admin" },
    alice: { id: aliceId, role: "member" },
    bob: { id: bobId, role: "member" },
    acme,
    globex,
    meetingAcme1: mkMeeting(acme, 1, daysAgoIso(30)),
    meetingAcme2: mkMeeting(acme, 2, daysAgoIso(10)),
    meetingGlobex1: mkMeeting(globex, 1, daysAgoIso(20)),
  };
}

export interface InsightOpts {
  meetingId: string;
  clientId: string;
  state?: string;
  track?: string | null;
  assignee?: string | null;
  priority?: number;
  title?: string;
  body?: string;
  itemType?: string;
  createdAt?: string;
}

export function makeInsight(db: Database, opts: InsightOpts): string {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  const body = opts.body ?? "original body";
  db.query(
    `INSERT INTO insights (id, meeting_id, client_id, item_type, track, title, body_original, body_current,
                           state, assignee_user_id, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.meetingId,
    opts.clientId,
    opts.itemType ?? "feature_request",
    opts.track ?? null,
    opts.title ?? "Test insight",
    body,
    body,
    opts.state ?? "extracted",
    opts.assignee ?? null,
    opts.priority ?? 0,
    t,
    t,
  );
  return id;
}

export function addMention(
  db: Database,
  insightId: string,
  meetingId: string,
  clientId: string,
  quote: string,
  createdAt?: string,
): string {
  const id = ulid();
  db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, created_at)
     VALUES (?, ?, ?, ?, ?, 'Client CTO', ?)`,
  ).run(id, insightId, meetingId, clientId, quote, createdAt ?? nowIso());
  return id;
}

export function addRequester(
  db: Database,
  insightId: string,
  clientId: string,
  first: string,
  last: string,
): void {
  db.query(
    "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
  ).run(insightId, clientId, first, last);
}
