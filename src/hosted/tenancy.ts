import { type Database, migrate, nowIso, withTenant, currentTenant } from "../db.ts";
import { ulid } from "../ids.ts";
import { env } from "../config.ts";
import { CONTROL_MIGRATIONS } from "../migrations.generated.ts";

/**
 * Hosted mode: one Postgres schema per workspace (ws_<id>), plus a small
 * `control` schema that maps people and sessions to their workspace and keeps
 * the free meeting quota. Every control query names its schema explicitly, so
 * it reads the same inside or outside withTenant().
 */

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
  for (const m of CONTROL_MIGRATIONS) {
    await db.exec(m.sql);
  }
}

/**
 * Workspaces resolve names in their own schema, then "extensions" only. Refuse
 * to serve if citext is not there (workspace tables need it) or if app tables
 * ever landed in "extensions" (they would be shared by every workspace).
 */
export async function assertExtensionsReady(db: Database): Promise<void> {
  const row = (await db
    .query(
      `SELECT to_regtype('extensions.citext') IS NOT NULL AS citext,
              EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'extensions') AS polluted`,
    )
    .get()) as { citext: number; polluted: number };
  if (!row.citext) throw new Error('Hosted mode needs the citext extension in the "extensions" schema (the control migration moves it).');
  if (row.polluted) throw new Error('Hosted mode found tables in the "extensions" schema; workspaces would share them. Move them out before serving.');
}

/** Applies migrations/*.sql (embedded) to every workspace schema (run on deploy). */
export async function migrateAllWorkspaces(db: Database): Promise<number> {
  const all = (await db
    .query(
      `SELECT w.schema_name, n.nspname IS NOT NULL AS present FROM control.workspaces w
       LEFT JOIN pg_namespace n ON n.nspname = w.schema_name ORDER BY w.created_at`,
    )
    .all()) as { schema_name: string; present: number }[];
  let done = 0;
  for (const w of all) {
    // A missing schema would let search_path fall through to "extensions" and
    // create the app tables there, shared by everyone. Never migrate it.
    if (!w.present) {
      console.warn(`hosted: workspace schema ${w.schema_name} is missing; skipped`);
      continue;
    }
    await withTenant(w.schema_name, () => migrate(db));
    done++;
  }
  return done;
}

export async function getWorkspace(db: Database, id: string): Promise<Workspace | null> {
  return (await db.query("SELECT * FROM control.workspaces WHERE id = ?").get(id)) as Workspace | null;
}

export interface Membership {
  workspace: Workspace;
  userId: string;
  status: "active" | "invited";
  invitedBy: string | null;
}

export async function membershipFor(db: Database, email: string): Promise<Membership | null> {
  const row = (await db
    .query(
      `SELECT w.*, m.user_id AS member_user_id, m.status AS member_status, m.invited_by AS member_invited_by
       FROM control.members m JOIN control.workspaces w ON w.id = m.workspace_id
       WHERE m.email = ?`,
    )
    .get(email.trim().toLowerCase())) as
    | (Workspace & { member_user_id: string; member_status: "active" | "invited"; member_invited_by: string | null })
    | null;
  if (!row) return null;
  const { member_user_id, member_status, member_invited_by, ...workspace } = row;
  return { workspace, userId: member_user_id, status: member_status, invitedBy: member_invited_by };
}

/**
 * New workspace for a first-time sign-in: registry row, its own schema with the
 * full app schema, and the signer as its admin. On any failure the schema and
 * row are removed, so a half-built workspace never lingers.
 */
export async function createWorkspace(
  db: Database,
  input: { email: string; productName: string; productDescription?: string | null; passwordHash?: string },
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
  // Build the schema completely first and register it last: a registry row
  // must never point at a schema that does not exist (see workspaceForSession).
  try {
    await db.exec(`CREATE SCHEMA ${schema};`);
    await withTenant(schema, async () => {
      await migrate(db);
      await db
        .query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
        .run(userId, email, email.split("@")[0]!, now);
    });
    await db.transaction(async () => {
      await db
        .query(
          `INSERT INTO control.workspaces (id, schema_name, name, product_name, product_description, owner_email, meetings_quota, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, schema, productName, productName, input.productDescription?.trim() || null, email, env.FREE_MEETINGS_PER_WORKSPACE, now);
      await db
        .query("INSERT INTO control.members (email, workspace_id, user_id, status, created_at) VALUES (?, ?, ?, 'active', ?)")
        .run(email, id, userId, now);
      // Password sign-up: the credential is part of the same transaction, so
      // a failure never leaves an account that has no way to sign in.
      if (input.passwordHash) {
        await db
          .query(
            "INSERT INTO control.credentials (email, workspace_id, user_id, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(email, id, userId, input.passwordHash, now, now);
      }
    });
  } catch (err) {
    await db.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE;`).catch(() => {});
    // Two sign-ups for one email racing: the loser hits the members key.
    if (/duplicate key|unique/i.test(String((err as Error)?.message ?? err))) throw new AlreadyMemberError(email);
    throw err;
  }
  return { workspace: (await getWorkspace(db, id))!, userId };
}

/** A teammate added by an admin signs in with their own email code. */
export class TooManyMembersError extends Error {}

/**
 * An admin invites a teammate. The invite stays 'invited' until the invitee
 * signs in with their own email code and accepts (acceptInvite); until then
 * it grants nothing.
 */
export async function addMember(
  db: Database,
  workspaceId: string,
  email: string,
  userId: string,
  invitedBy: string,
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (await membershipFor(db, normalized)) throw new AlreadyMemberError(normalized);
  const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.members WHERE workspace_id = ?").get(workspaceId)) as {
    n: number;
  };
  if (n >= env.MAX_MEMBERS_PER_WORKSPACE) throw new TooManyMembersError("This workspace has reached its member limit.");
  try {
    await db
      .query("INSERT INTO control.members (email, workspace_id, user_id, status, invited_by, created_at) VALUES (?, ?, ?, 'invited', ?, ?)")
      .run(normalized, workspaceId, userId, invitedBy, nowIso());
  } catch (err) {
    if (/duplicate key|unique/i.test(String((err as Error)?.message ?? err))) throw new AlreadyMemberError(normalized);
    throw err;
  }
}

export async function acceptInvite(db: Database, email: string): Promise<void> {
  await db.query("UPDATE control.members SET status = 'active' WHERE email = ? AND status = 'invited'").run(email);
}

/** Declining (or a revoked teammate) frees the email for its own workspace. */
export async function removeMember(db: Database, email: string): Promise<Membership | null> {
  const m = await membershipFor(db, email);
  if (!m) return null;
  await db.query("DELETE FROM control.members WHERE email = ?").run(email.trim().toLowerCase());
  return m;
}

export async function removeMemberByUser(db: Database, workspaceId: string, userId: string): Promise<void> {
  await db.query("DELETE FROM control.members WHERE workspace_id = ? AND user_id = ?").run(workspaceId, userId);
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
       JOIN pg_namespace n ON n.nspname = w.schema_name
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
  // Record the hit first, then count: parallel requests cannot all pass a
  // check that ran before any of their inserts landed.
  const now = Date.now();
  await db.query("INSERT INTO control.rate_hits (key, at) VALUES (?, ?)").run(key, now);
  const { n } = (await db
    .query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key = ? AND at >= ?")
    .get(key, now - windowMs)) as { n: number };
  return n > limit;
}

export async function pruneControl(db: Database, now = Date.now()): Promise<Record<string, number>> {
  const s = await db.query("DELETE FROM control.sessions WHERE expires_at <= ?").run(new Date(now).toISOString());
  const r = await db.query("DELETE FROM control.rate_hits WHERE at < ?").run(now - 24 * 3_600_000);
  const p = await db.query("DELETE FROM control.pending_signups WHERE expires_at <= ?").run(new Date(now).toISOString());
  const ws = await db.query("DELETE FROM control.llm_spend_ws WHERE day < ?").run(new Date(now - 7 * 86_400_000).toISOString().slice(0, 10));
  return { sessions: s.changes, rate_hits: r.changes, pending_signups: p.changes, ws_spend_days: ws.changes };
}

export async function listWorkspaces(db: Database): Promise<Workspace[]> {
  return (await db.query("SELECT * FROM control.workspaces ORDER BY created_at").all()) as Workspace[];
}

/** True when this email's only claim is an unverified password sign-up. */
export async function isUnverifiedClaim(db: Database, email: string): Promise<boolean> {
  const row = await db.query("SELECT 1 AS x FROM control.credentials WHERE email = ?").get(email.trim().toLowerCase());
  return !!row;
}

/**
 * Someone just proved they own this inbox (emailed link or code) while an
 * unverified password account holds the email: remove that claim instead of
 * signing the verified person into it. The squatter's membership, password
 * (cascade) and sessions in that workspace go; the workspace's data stays
 * with whoever else belongs to it.
 */
export async function evictUnverifiedClaim(db: Database, email: string): Promise<void> {
  const m = await membershipFor(db, email);
  if (!m) return;
  await db.query("DELETE FROM control.members WHERE email = ?").run(email.trim().toLowerCase());
  await withTenant(m.workspace.schema_name, async () => {
    await db.query("DELETE FROM sessions WHERE user_id = ?").run(m.userId);
    await db.query("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(nowIso(), m.userId);
  });
}

/** Counts hits without recording one (failure-only lockouts). */
export async function controlHitCount(db: Database, key: string, windowMs: number): Promise<number> {
  const { n } = (await db
    .query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key = ? AND at >= ?")
    .get(key, Date.now() - windowMs)) as { n: number };
  return n;
}

export async function recordControlHit(db: Database, key: string): Promise<void> {
  await db.query("INSERT INTO control.rate_hits (key, at) VALUES (?, ?)").run(key, Date.now());
}
