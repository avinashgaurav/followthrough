import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Database, migrate, nowIso, withTenant, currentTenant } from "../db.ts";
import { ulid } from "../ids.ts";
import { env } from "../config.ts";

/**
 * Hosted mode: one Postgres schema per workspace (ws_<id>), plus a small
 * `control` schema that maps people and sessions to their workspace and keeps
 * the free meeting quota. Every control query names its schema explicitly, so
 * it reads the same inside or outside withTenant().
 */

const CONTROL_DIR = join(import.meta.dir, "..", "..", "migrations-control");

export interface Workspace {
  id: string;
  schema_name: string;
  name: string;
  product_name: string;
  product_description: string | null;
  owner_email: string;
  meetings_quota: number;
  meetings_used: number;
}

export class SignupsFullError extends Error {}
export class AlreadyMemberError extends Error {}

export function schemaFor(workspaceId: string): string {
  return `ws_${workspaceId.toLowerCase()}`;
}

/** The workspace id behind the request's pinned schema, or null outside a workspace. */
export function currentWorkspaceId(): string | null {
  const s = currentTenant();
  return s ? s.slice(3).toUpperCase() : null;
}

export async function migrateControl(db: Database): Promise<void> {
  for (const file of readdirSync(CONTROL_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(CONTROL_DIR, file), "utf8"));
  }
}

/**
 * Refuse to serve if app tables sit in the shared public schema. Workspace
 * schemas resolve names before public, so a table that one workspace lacked
 * (say, a migration that had not reached it yet) would otherwise fall through
 * to shared data.
 */
export async function assertPublicHasNoAppTables(db: Database): Promise<void> {
  const row = (await db
    .query("SELECT to_regclass('public.insights') IS NOT NULL AS bad, to_regclass('public.users') IS NOT NULL AS bad2")
    .get()) as { bad: number; bad2: number };
  if (row.bad || row.bad2) {
    throw new Error(
      "Hosted mode found app tables in the public schema. Use a fresh Supabase project (or drop them): workspace data must never fall through to public.",
    );
  }
}

/** Applies migrations/*.sql to every workspace schema (run on deploy). */
export async function migrateAllWorkspaces(db: Database): Promise<number> {
  const all = (await db.query("SELECT schema_name FROM control.workspaces ORDER BY created_at").all()) as {
    schema_name: string;
  }[];
  for (const w of all) await withTenant(w.schema_name, () => migrate(db));
  return all.length;
}

export async function getWorkspace(db: Database, id: string): Promise<Workspace | null> {
  return (await db.query("SELECT * FROM control.workspaces WHERE id = ?").get(id)) as Workspace | null;
}

export async function membershipFor(
  db: Database,
  email: string,
): Promise<{ workspace: Workspace; userId: string } | null> {
  const row = (await db
    .query(
      `SELECT w.*, m.user_id AS member_user_id FROM control.members m
       JOIN control.workspaces w ON w.id = m.workspace_id
       WHERE m.email = ?`,
    )
    .get(email.trim().toLowerCase())) as (Workspace & { member_user_id: string }) | null;
  if (!row) return null;
  const { member_user_id, ...workspace } = row;
  return { workspace, userId: member_user_id };
}

/**
 * New workspace for a first-time sign-in: registry row, its own schema with the
 * full app schema, and the signer as its admin. On any failure the schema and
 * row are removed, so a half-built workspace never lingers.
 */
export async function createWorkspace(
  db: Database,
  input: { email: string; productName: string; productDescription?: string | null },
): Promise<{ workspace: Workspace; userId: string }> {
  const email = input.email.trim().toLowerCase();
  if (await membershipFor(db, email)) throw new AlreadyMemberError(email);
  const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
  if (n >= env.MAX_WORKSPACES) throw new SignupsFullError("Sign-ups are full right now.");

  const id = ulid();
  const schema = schemaFor(id);
  const userId = ulid();
  const productName = input.productName.trim();
  const now = nowIso();
  await db
    .query(
      `INSERT INTO control.workspaces (id, schema_name, name, product_name, product_description, owner_email, meetings_quota, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, schema, productName, productName, input.productDescription?.trim() || null, email, env.FREE_MEETINGS_PER_WORKSPACE, now);
  try {
    await db.exec(`CREATE SCHEMA ${schema};`);
    await withTenant(schema, async () => {
      await migrate(db);
      await db
        .query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
        .run(userId, email, email.split("@")[0]!, now);
    });
    await db
      .query("INSERT INTO control.members (email, workspace_id, user_id, created_at) VALUES (?, ?, ?, ?)")
      .run(email, id, userId, now);
  } catch (err) {
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`).catch(() => {});
    await db.query("DELETE FROM control.workspaces WHERE id = ?").run(id).catch(() => {});
    throw err;
  }
  return { workspace: (await getWorkspace(db, id))!, userId };
}

/** A teammate added by an admin signs in with their own email code. */
export async function addMember(db: Database, workspaceId: string, email: string, userId: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const existing = await membershipFor(db, normalized);
  if (existing) throw new AlreadyMemberError(normalized);
  await db
    .query("INSERT INTO control.members (email, workspace_id, user_id, created_at) VALUES (?, ?, ?, ?)")
    .run(normalized, workspaceId, userId, nowIso());
}

/** Opens a session in the workspace and records which workspace the cookie belongs to. */
export async function openSession(
  db: Database,
  workspace: Workspace,
  userId: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<string> {
  const id = ulid();
  const now = nowIso();
  const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000).toISOString();
  await withTenant(workspace.schema_name, () =>
    db
      .query("INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, now, expires, meta.ip, meta.userAgent),
  );
  await db.query("INSERT INTO control.sessions (id, workspace_id, expires_at) VALUES (?, ?, ?)").run(id, workspace.id, expires);
  return id;
}

/** The workspace a session cookie belongs to (expiry and the user are checked in the workspace). */
export async function workspaceForSession(db: Database, sessionId: string | null): Promise<Workspace | null> {
  if (!sessionId) return null;
  return (await db
    .query(
      `SELECT w.* FROM control.sessions s JOIN control.workspaces w ON w.id = s.workspace_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sessionId, nowIso())) as Workspace | null;
}

/** Takes one free meeting; false when the quota is used up. Atomic under concurrency. */
export async function reserveMeeting(db: Database, workspaceId: string): Promise<boolean> {
  const r = await db
    .query(
      "UPDATE control.workspaces SET meetings_used = meetings_used + 1 WHERE id = ? AND meetings_used < meetings_quota RETURNING meetings_used",
    )
    .run(workspaceId);
  return r.rows.length > 0;
}

export async function refundMeeting(db: Database, workspaceId: string): Promise<void> {
  await db
    .query("UPDATE control.workspaces SET meetings_used = GREATEST(meetings_used - 1, 0) WHERE id = ?")
    .run(workspaceId);
}

/** Simple sliding-window throttle shared by every instance (sign-in codes). */
export async function controlRateLimited(db: Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const { n } = (await db
    .query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key = ? AND at >= ?")
    .get(key, now - windowMs)) as { n: number };
  if (n >= limit) return true;
  await db.query("INSERT INTO control.rate_hits (key, at) VALUES (?, ?)").run(key, now);
  return false;
}

export async function pruneControl(db: Database, now = Date.now()): Promise<{ sessions: number; rate_hits: number }> {
  const s = await db.query("DELETE FROM control.sessions WHERE expires_at <= ?").run(new Date(now).toISOString());
  const r = await db.query("DELETE FROM control.rate_hits WHERE at < ?").run(now - 24 * 3_600_000);
  return { sessions: s.changes, rate_hits: r.changes };
}

export async function listWorkspaces(db: Database): Promise<Workspace[]> {
  return (await db.query("SELECT * FROM control.workspaces ORDER BY created_at").all()) as Workspace[];
}
