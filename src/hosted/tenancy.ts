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
/** The operator paused sign-ups with a database trigger whose message starts "Sign-ups are paused". */
export class SignupsPausedError extends Error {}
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
  if (!row.citext) {
    throw new Error(
      'Hosted mode needs the citext extension in the "extensions" schema. It exists elsewhere, and boot never moves a ' +
        "shared extension by itself: run ALTER EXTENSION citext SET SCHEMA extensions; once (docs/HOSTED.md).",
    );
  }
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
  // Cheap early refusal; the binding check is under the lock below.
  if ((await workspaceCount(db)) >= env.MAX_WORKSPACES) throw new SignupsFullError("Sign-ups are full right now.");

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
      // Count and insert under one lock, so parallel sign-ups cannot all pass
      // a check that ran before any of them registered.
      await db.query("SELECT pg_advisory_xact_lock(hashtext('followthrough:workspaces'))").run();
      if ((await workspaceCount(db)) >= env.MAX_WORKSPACES) throw new SignupsFullError("Sign-ups are full right now.");
      await db
        .query(
          `INSERT INTO control.workspaces (id, schema_name, name, product_name, product_description, owner_email, meetings_quota, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, schema, productName, productName, input.productDescription?.trim() || null, email, env.FREE_MEETINGS_PER_WORKSPACE, now);
      // Without a password the email was proven (code or link) to get here;
      // a password sign-up is an unverified claim until the inbox is proven.
      await db
        .query(
          "INSERT INTO control.members (email, workspace_id, user_id, status, created_at, verified_at) VALUES (?, ?, ?, 'active', ?, ?)",
        )
        .run(email, id, userId, now, input.passwordHash ? null : now);
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
    const message = String((err as Error)?.message ?? err);
    if (/duplicate key|unique/i.test(message)) throw new AlreadyMemberError(email);
    if (/^Sign-ups are paused/.test(message)) throw new SignupsPausedError(message);
    throw err;
  }
  return { workspace: (await getWorkspace(db, id))!, userId };
}

async function workspaceCount(db: Database): Promise<number> {
  const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
  return n;
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
  try {
    // Count and insert under a per-workspace lock (parallel invites cannot overshoot).
    await db.transaction(async () => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext(?))").run(`followthrough:members:${workspaceId}`);
      const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.members WHERE workspace_id = ?").get(workspaceId)) as {
        n: number;
      };
      if (n >= env.MAX_MEMBERS_PER_WORKSPACE) throw new TooManyMembersError("This workspace has reached its member limit.");
      await db
        .query("INSERT INTO control.members (email, workspace_id, user_id, status, invited_by, created_at) VALUES (?, ?, ?, 'invited', ?, ?)")
        .run(normalized, workspaceId, userId, invitedBy, nowIso());
    });
  } catch (err) {
    if (/duplicate key|unique/i.test(String((err as Error)?.message ?? err))) throw new AlreadyMemberError(normalized);
    throw err;
  }
}

export async function acceptInvite(db: Database, email: string): Promise<void> {
  // Accepting follows an inbox sign-in, so it also verifies the email.
  await db
    .query("UPDATE control.members SET status = 'active', verified_at = ? WHERE email = ? AND status = 'invited'")
    .run(nowIso(), email);
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

/**
 * Password login's session: opened only while the password (credential row)
 * still exists, under a row lock. A promotion (promoteUnverifiedClaim) deletes
 * that row, so either it commits first and this refuses (null), or it waits
 * for this to commit and then removes the session it made. Statements name the
 * schema: a transaction outside withTenant has no search_path pin.
 */
export async function openPasswordSession(
  db: Database,
  workspace: Workspace,
  userId: string,
  email: string,
  meta: { ip: string | null; userAgent: string | null },
): Promise<string | null> {
  const schema = workspace.schema_name;
  if (!WS_SCHEMA.test(schema)) throw new Error(`not a workspace schema: "${schema}"`);
  return db.transaction(async () => {
    const held = await db
      .query("SELECT 1 AS x FROM control.credentials WHERE email = ? AND workspace_id = ? AND user_id = ? FOR SHARE")
      .get(email, workspace.id, userId);
    if (!held) return null;
    const id = ulid();
    const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000).toISOString();
    await db
      .query(`INSERT INTO ${schema}.sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, userId, nowIso(), expires, meta.ip, meta.userAgent);
    await db.query("INSERT INTO control.sessions (id, workspace_id, expires_at) VALUES (?, ?, ?)").run(id, workspace.id, expires);
    return id;
  });
}

const WS_SCHEMA = /^ws_[a-z0-9]{1,40}$/;

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
  // Already over the limit: refuse without adding a row, so a flood of
  // refused requests cannot keep growing control.rate_hits (issue #22).
  if ((await controlHitCount(db, key, windowMs)) >= limit) return true;
  // Under it: record the hit first, then count, so parallel requests cannot
  // all pass a check that ran before any of their inserts landed.
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
  const l = await db.query("DELETE FROM control.used_links WHERE expires_at <= ?").run(new Date(now).toISOString());
  // Invite links a week past their expiry (used, revoked or not) are history.
  const il = await db.query("DELETE FROM control.invite_links WHERE expires_at <= ?").run(new Date(now - 7 * 86_400_000).toISOString());
  return {
    sessions: s.changes,
    rate_hits: r.changes,
    pending_signups: p.changes,
    ws_spend_days: ws.changes,
    used_links: l.changes,
    invite_links: il.changes,
  };
}

export async function listWorkspaces(db: Database): Promise<Workspace[]> {
  return (await db.query("SELECT * FROM control.workspaces ORDER BY created_at").all()) as Workspace[];
}

/** True when this email's only claim is an unverified password sign-up. */
export async function isUnverifiedClaim(db: Database, email: string): Promise<boolean> {
  const row = await db
    .query(
      `SELECT 1 AS x FROM control.members m JOIN control.credentials c ON c.email = m.email
       WHERE m.email = ? AND m.verified_at IS NULL`,
    )
    .get(email.trim().toLowerCase());
  return !!row;
}

/**
 * Someone just proved they own this inbox (emailed link or code) while an
 * unverified password account holds the email. Nothing tells the real owner
 * who forgot their password apart from a squatter, so the inbox wins without
 * deleting any data: the membership becomes verified and keeps its workspace,
 * while the password, every session in the workspace, and every other member
 * or invite (users disabled, rows kept) and every client share link are removed. A squatter, and anyone
 * they let in, is out; a real owner re-invites their teammates. All in one
 * transaction. Returns false if there was nothing to promote.
 */
export async function promoteUnverifiedClaim(db: Database, email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const m = await membershipFor(db, normalized);
  if (!m) return false;
  const schema = m.workspace.schema_name;
  // Named directly below: a transaction outside withTenant has no search_path pin.
  if (!WS_SCHEMA.test(schema)) throw new Error(`not a workspace schema: "${schema}"`);
  // A teammate who joined by invite link is not the workspace's owner: the
  // link was handed to a person, not to this email. Proving the inbox must not
  // give the email's owner a seat in someone else's workspace, so that
  // membership is removed instead (the email is then free for its own
  // workspace). Nobody else in the workspace is touched.
  if (m.workspace.owner_email.trim().toLowerCase() !== normalized) {
    return db.transaction(async () => {
      const gone = await db
        .query(
          `DELETE FROM control.members m WHERE m.email = ? AND m.verified_at IS NULL
           AND EXISTS (SELECT 1 FROM control.credentials c WHERE c.email = m.email)
           RETURNING m.user_id, m.workspace_id`,
        )
        .run(normalized);
      if (gone.rows.length === 0) return false;
      const row = gone.rows[0] as { user_id: string; workspace_id: string };
      await db.query(`UPDATE ${schema}.users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL`).run(nowIso(), row.user_id);
      await db.query(`UPDATE ${schema}.api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(nowIso(), row.user_id);
      await db.query(`DELETE FROM control.sessions WHERE id IN (SELECT id FROM ${schema}.sessions WHERE user_id = ?)`).run(row.user_id);
      await db.query(`DELETE FROM ${schema}.sessions WHERE user_id = ?`).run(row.user_id);
      return true;
    });
  }
  return db.transaction(async () => {
    const won = await db
      .query("UPDATE control.members SET verified_at = ? WHERE email = ? AND verified_at IS NULL RETURNING email")
      .run(nowIso(), normalized);
    if (won.rows.length === 0) return false; // already verified (a parallel sign-in did it)
    // Waits for any password login holding this row (openPasswordSession).
    await db.query("DELETE FROM control.credentials WHERE email = ?").run(normalized);
    // Re-read under the member row lock the UPDATE above took: the workspace
    // and user acted on below are the ones this email holds now.
    const cur = (await db
      .query(
        `SELECT m.user_id, w.id AS workspace_id, w.schema_name FROM control.members m
         JOIN control.workspaces w ON w.id = m.workspace_id WHERE m.email = ?`,
      )
      .get(normalized)) as { user_id: string; workspace_id: string; schema_name: string };
    if (cur.schema_name !== schema) throw new Error("membership changed during promotion");
    await db.query("DELETE FROM control.members WHERE workspace_id = ? AND email <> ?").run(cur.workspace_id, normalized);
    // Links made while the password holder had the workspace would let them
    // (or anyone they gave one to) straight back in.
    await db
      .query("UPDATE control.invite_links SET revoked_at = ? WHERE workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL")
      .run(nowIso(), cur.workspace_id);
    await db.query(`UPDATE ${schema}.users SET disabled_at = ? WHERE id <> ? AND disabled_at IS NULL`).run(nowIso(), cur.user_id);
    // Every API token was made while the password holder had the workspace,
    // including the owner account's own: none of them survive the takeover.
    await db.query(`UPDATE ${schema}.api_tokens SET revoked_at = ? WHERE revoked_at IS NULL`).run(nowIso());
    // Whoever held the password knows the client share links: turn them off
    // (the owner makes new ones from the client page).
    await db.query(`UPDATE ${schema}.clients SET share_token = NULL WHERE share_token IS NOT NULL`).run();
    await db.query(`DELETE FROM control.sessions WHERE id IN (SELECT id FROM ${schema}.sessions)`).run();
    await db.query(`DELETE FROM ${schema}.sessions`).run();
    return true;
  });
}

/** Marks an emailed link as used; false if it already was (single use). */
export async function claimLinkUse(db: Database, key: string, ttlMs = 24 * 3_600_000): Promise<boolean> {
  const r = await db
    .query("INSERT INTO control.used_links (key, expires_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key")
    .run(key, new Date(Date.now() + ttlMs).toISOString());
  return r.rows.length > 0;
}

/** Gives a link back when the sign-in it started failed on our side (it can be retried). */
export async function releaseLinkUse(db: Database, key: string): Promise<void> {
  await db.query("DELETE FROM control.used_links WHERE key = ?").run(key);
}

/** Counts hits without recording one (failure-only lockouts). */
export async function controlHitCount(db: Database, key: string, windowMs: number): Promise<number> {
  const { n } = (await db
    .query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key = ? AND at >= ?")
    .get(key, Date.now() - windowMs)) as { n: number };
  return n;
}

/** Records a hit and returns its timestamp, so a hit can be withdrawn (see withdrawControlHit). */
export async function recordControlHit(db: Database, key: string): Promise<number> {
  const at = Date.now();
  await db.query("INSERT INTO control.rate_hits (key, at) VALUES (?, ?)").run(key, at);
  return at;
}

export async function withdrawControlHit(db: Database, key: string, at: number): Promise<void> {
  await db.query("DELETE FROM control.rate_hits WHERE key = ? AND at = ?").run(key, at);
}

// ---------------------------------------------------------------- recovery codes

/** No 0/O, 1/I/L: a code people copy by hand. 12 chars from 31 = about 59 bits. */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newRecoveryCode(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  // 256 % 31 leaves a tiny bias; at 59 bits it does not matter.
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

/** What the person typed, in the stored form: upper case, no spaces or dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Stores (or replaces) the code hash for a password account. False if the email has no password. */
export async function saveRecoveryCode(db: Database, email: string, codeHash: string): Promise<boolean> {
  const r = await db
    .query(
      `INSERT INTO control.recovery_codes (email, code_hash, created_at)
       SELECT email, ?, ? FROM control.credentials WHERE email = ?
       ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, created_at = EXCLUDED.created_at
       RETURNING email`,
    )
    .run(codeHash, nowIso(), email.trim().toLowerCase());
  return r.rows.length > 0;
}

export async function recoveryFor(
  db: Database,
  email: string,
): Promise<{ code_hash: string; workspace_id: string; user_id: string } | null> {
  return (await db
    .query(
      `SELECT r.code_hash, c.workspace_id, c.user_id FROM control.recovery_codes r
       JOIN control.credentials c ON c.email = r.email WHERE r.email = ?`,
    )
    .get(email.trim().toLowerCase())) as { code_hash: string; workspace_id: string; user_id: string } | null;
}

/**
 * New password and recovery code in one transaction, only if the code hash is
 * still the one that was checked (a parallel reset cannot spend it twice).
 * Every session of that user is ended. False if the code changed meanwhile.
 */
export async function resetPassword(
  db: Database,
  email: string,
  checkedCodeHash: string,
  passwordHash: string,
  nextCodeHash: string,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const m = await membershipFor(db, normalized);
  if (!m) return false;
  const schema = m.workspace.schema_name;
  if (!WS_SCHEMA.test(schema)) throw new Error(`not a workspace schema: "${schema}"`);
  return db.transaction(async () => {
    const spent = await db
      .query("UPDATE control.recovery_codes SET code_hash = ?, created_at = ? WHERE email = ? AND code_hash = ? RETURNING email")
      .run(nextCodeHash, nowIso(), normalized, checkedCodeHash);
    if (spent.rows.length === 0) return false;
    await db.query("UPDATE control.credentials SET password_hash = ? WHERE email = ?").run(passwordHash, normalized);
    await db.query(`DELETE FROM control.sessions WHERE id IN (SELECT id FROM ${schema}.sessions WHERE user_id = ?)`).run(m.userId);
    await db.query(`DELETE FROM ${schema}.sessions WHERE user_id = ?`).run(m.userId);
    // A reset suggests the password leaked: tokens made with it go too.
    await db.query(`UPDATE ${schema}.api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`).run(nowIso(), m.userId);
    return true;
  });
}

// ---------------------------------------------------------------- invite links

export const INVITE_LINK_TTL_MS = 48 * 3_600_000;
export const MAX_OPEN_INVITE_LINKS = 10;

export class InviteLinkSpentError extends Error {}

export function newInviteToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

export function inviteTokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export interface InviteLinkRow {
  id: string;
  role: "admin" | "member";
  created_by: string;
  created_at: string;
  expires_at: string;
}

export async function openInviteLinks(db: Database, workspaceId: string): Promise<InviteLinkRow[]> {
  return (await db
    .query(
      `SELECT id, role, created_by, created_at, expires_at FROM control.invite_links
       WHERE workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC`,
    )
    .all(workspaceId, nowIso())) as InviteLinkRow[];
}

/** A new link, or null when the workspace already has the maximum of open links. */
export async function createInviteLink(
  db: Database,
  workspaceId: string,
  role: "admin" | "member",
  createdBy: string,
): Promise<{ id: string; token: string; expires_at: string } | null> {
  const id = ulid();
  const token = newInviteToken();
  const expires = new Date(Date.now() + INVITE_LINK_TTL_MS).toISOString();
  return db.transaction(async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext(?))").run(`followthrough:invite-links:${workspaceId}`);
    if ((await openInviteLinks(db, workspaceId)).length >= MAX_OPEN_INVITE_LINKS) return null;
    await db
      .query(
        `INSERT INTO control.invite_links (id, token_hash, workspace_id, role, created_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, inviteTokenHash(token), workspaceId, role, createdBy, nowIso(), expires);
    return { id, token, expires_at: expires };
  });
}

export async function revokeInviteLink(db: Database, workspaceId: string, id: string): Promise<boolean> {
  const r = await db
    .query(
      "UPDATE control.invite_links SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND used_at IS NULL AND revoked_at IS NULL RETURNING id",
    )
    .run(nowIso(), id, workspaceId);
  return r.rows.length > 0;
}

/** The workspace an open link leads to, for the join page. Null if spent, revoked, expired or unknown. */
export async function inviteLinkInfo(
  db: Database,
  token: string,
): Promise<{ workspace: Workspace; created_by: string; expires_at: string } | null> {
  const row = (await db
    .query(
      `SELECT workspace_id, created_by, expires_at FROM control.invite_links
       WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .get(inviteTokenHash(token), nowIso())) as { workspace_id: string; created_by: string; expires_at: string } | null;
  if (!row) return null;
  const workspace = await getWorkspace(db, row.workspace_id);
  return workspace ? { workspace, created_by: row.created_by, expires_at: row.expires_at } : null;
}

/**
 * Spends the link and adds the person in one transaction: the workspace user,
 * an active (unverified) membership, their password and recovery code. Any
 * refusal (link spent, email taken, workspace full) rolls everything back, so
 * a link is only used up by a join that worked.
 */
export async function joinWithInviteLink(
  db: Database,
  input: { token: string; email: string; name: string; passwordHash: string; recoveryCodeHash: string },
): Promise<{ workspace: Workspace; userId: string }> {
  const email = input.email.trim().toLowerCase();
  const tokenHash = inviteTokenHash(input.token);
  let userId = ulid();
  const now = nowIso();
  try {
    const workspaceId = await db.transaction(async () => {
      const link = (await db
        .query(
          `UPDATE control.invite_links SET used_at = ?, used_by_email = ?
           WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           RETURNING workspace_id, role, created_by`,
        )
        .run(now, email, tokenHash, now)).rows[0] as { workspace_id: string; role: string; created_by: string } | undefined;
      if (!link) throw new InviteLinkSpentError("That invite link has expired, was revoked, or was already used.");
      const ws = await getWorkspace(db, link.workspace_id);
      if (!ws || !WS_SCHEMA.test(ws.schema_name)) throw new InviteLinkSpentError("That workspace no longer exists.");
      // Same lock as addMember, so links and email invites share one member cap.
      await db.query("SELECT pg_advisory_xact_lock(hashtext(?))").run(`followthrough:members:${ws.id}`);
      const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.members WHERE workspace_id = ?").get(ws.id)) as { n: number };
      if (n >= env.MAX_MEMBERS_PER_WORKSPACE) throw new TooManyMembersError("This workspace has reached its member limit.");
      // A link is only as good as the admin who made it: once they are removed,
      // disabled or no longer an admin, their open links stop working.
      const inviter = (await db
        .query(
          `SELECT u.id, u.email FROM ${ws.schema_name}.users u
           JOIN control.members m ON m.user_id = u.id AND m.workspace_id = ? AND m.status = 'active'
           WHERE u.id = ? AND u.role = 'admin' AND u.disabled_at IS NULL`,
        )
        .get(ws.id, link.created_by)) as { id: string; email: string } | null;
      if (!inviter) throw new InviteLinkSpentError("The admin who made that invite link no longer has access.");
      // Someone who was removed from this workspace before keeps a disabled
      // user row (their history stays attributed); joining again re-enables it.
      const prior = (await db
        .query(`SELECT id, disabled_at FROM ${ws.schema_name}.users WHERE email = ?`)
        .get(email)) as { id: string; disabled_at: string | null } | null;
      if (prior && !prior.disabled_at) throw new AlreadyMemberError(email);
      if (prior) {
        userId = prior.id;
        // Re-joining never revives tokens from the earlier membership.
        await db
          .query(`UPDATE ${ws.schema_name}.api_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`)
          .run(now, prior.id);
        await db
          .query(`UPDATE ${ws.schema_name}.users SET disabled_at = NULL, code_hash = NULL, role = ?, name = ?, invited_by = ? WHERE id = ?`)
          .run(link.role, input.name.trim(), inviter.id, prior.id);
      } else {
        await db
          .query(`INSERT INTO ${ws.schema_name}.users (id, email, name, role, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(userId, email, input.name.trim(), link.role, inviter.id, now);
      }
      await db
        .query("INSERT INTO control.members (email, workspace_id, user_id, status, invited_by, created_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(email, ws.id, userId, inviter.email, now);
      await db
        .query(
          "INSERT INTO control.credentials (email, workspace_id, user_id, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(email, ws.id, userId, input.passwordHash, now, now);
      await db.query("INSERT INTO control.recovery_codes (email, code_hash, created_at) VALUES (?, ?, ?)").run(email, input.recoveryCodeHash, now);
      return ws.id;
    });
    return { workspace: (await getWorkspace(db, workspaceId))!, userId };
  } catch (err) {
    const message = String((err as Error)?.message ?? err);
    if (/duplicate key|unique/i.test(message)) throw new AlreadyMemberError(email);
    throw err;
  }
}
