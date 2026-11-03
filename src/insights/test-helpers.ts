import type { Database } from "../db.ts";
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

export async function seed(): Promise<Seeded> {
  const db = await openTestDb();
  const t = nowIso();

  const mkUser = async (name: string, role: "admin" | "member"): Promise<string> => {
    const id = ulid();
    await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
      id,
      `${name}-${id.slice(-4)}@tallyhall.com`,
      name,
      role,
      t,
    );
    return id;
  };
  const mkClient = async (name: string): Promise<string> => {
    const id = ulid();
    await db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(id, name, t);
    return id;
  };
  const adminId = await mkUser("admin", "admin");
  const aliceId = await mkUser("alice", "member");
  const bobId = await mkUser("bob", "member");
  const acme = await mkClient("Acme");
  const globex = await mkClient("Globex");

  const mkMeeting = async (clientId: string, seq: number, date: string): Promise<string> => {
    const id = ulid();
    await db.query(
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
    meetingAcme1: await mkMeeting(acme, 1, daysAgoIso(30)),
    meetingAcme2: await mkMeeting(acme, 2, daysAgoIso(10)),
    meetingGlobex1: await mkMeeting(globex, 1, daysAgoIso(20)),
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

export async function makeInsight(db: Database, opts: InsightOpts): Promise<string> {
  const id = ulid();
  const t = opts.createdAt ?? nowIso();
  const body = opts.body ?? "original body";
  await db.query(
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

export async function addMention(
  db: Database,
  insightId: string,
  meetingId: string,
  clientId: string,
  quote: string,
  createdAt?: string,
): Promise<string> {
  const id = ulid();
  await db.query(
    `INSERT INTO insight_mentions (id, insight_id, meeting_id, client_id, quote, speaker, created_at)
     VALUES (?, ?, ?, ?, ?, 'Client CTO', ?)`,
  ).run(id, insightId, meetingId, clientId, quote, createdAt ?? nowIso());
  return id;
}

export async function addRequester(
  db: Database,
  insightId: string,
  clientId: string,
  first: string,
  last: string,
): Promise<void> {
  await db.query(
    "INSERT INTO insight_requesters (insight_id, client_id, first_requested_at, last_requested_at) VALUES (?, ?, ?, ?)",
  ).run(insightId, clientId, first, last);
}
