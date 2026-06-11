import type { Database } from "bun:sqlite";
import { nowIso } from "./db.ts";
import { ulid } from "./ids.ts";
import { env } from "./config.ts";

/**
 * Auth (SPEC.md section 1): admin issues email + login code. Codes hashed,
 * revocable. Rate-limited login. Sessions as HTTP-only cookies.
 */

const MAX_FAILURES = 8;
const WINDOW_MINUTES = 15;

/** Hardcoded by founder decision (2026-06-10): only xyz.com people can have accounts. */
export const ALLOWED_EMAIL_DOMAIN = "xyz.com";

export function isAllowedEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${ALLOWED_EMAIL_DOMAIN}`);
}

export async function hashCode(code: string): Promise<string> {
  return Bun.password.hash(code, { algorithm: "argon2id" });
}

export async function verifyCode(code: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(code, hash);
  } catch {
    return false;
  }
}

export function generateLoginCode(): string {
  // 10 chars, unambiguous alphabet, ~50 bits. Admin hands this to the user.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function recentFailures(db: Database, email: string, ip: string | null): number {
  const since = new Date(Date.now() - WINDOW_MINUTES * 60_000).toISOString();
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE occurred_at > ? AND success = 0 AND (email = ? OR (ip IS NOT NULL AND ip = ?))`,
    )
    .get(since, email, ip) as { n: number };
  return row.n;
}

export type LoginResult =
  | { ok: true; sessionId: string; userId: string; role: "admin" | "member" }
  | { ok: false; reason: "locked_out" | "invalid" };

export async function login(
  db: Database,
  email: string,
  code: string,
  ip: string | null,
  userAgent: string | null,
): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  if (!isAllowedEmail(normalized)) return { ok: false, reason: "invalid" };
  if (recentFailures(db, normalized, ip) >= MAX_FAILURES) {
    return { ok: false, reason: "locked_out" };
  }

  const user = db
    .query(
      "SELECT id, role, code_hash FROM users WHERE email = ? AND disabled_at IS NULL",
    )
    .get(normalized) as { id: string; role: "admin" | "member"; code_hash: string | null } | null;

  const valid = !!user?.code_hash && (await verifyCode(code, user.code_hash));
  db.query(
    "INSERT INTO login_attempts (email, ip, occurred_at, success) VALUES (?, ?, ?, ?)",
  ).run(normalized, ip, nowIso(), valid ? 1 : 0);

  if (!user || !valid) return { ok: false, reason: "invalid" };

  const sessionId = ulid() + ulid(); // 52 chars of entropy
  const expires = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000).toISOString();
  db.query(
    "INSERT INTO sessions (id, user_id, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, user.id, nowIso(), expires, ip, userAgent);

  return { ok: true, sessionId, userId: user.id, role: user.role };
}

export interface AuthedUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}

export function userForSession(db: Database, sessionId: string | null): AuthedUser | null {
  if (!sessionId) return null;
  const row = db
    .query(
      `SELECT u.id, u.email, u.name, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.disabled_at IS NULL`,
    )
    .get(sessionId, nowIso()) as AuthedUser | null;
  return row;
}

export function logout(db: Database, sessionId: string): void {
  db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

/** Revoke a user's login code (offboarding). Kills their sessions too. */
export function revokeCode(db: Database, userId: string): void {
  db.query("UPDATE users SET code_hash = NULL, code_rotated_at = ? WHERE id = ?").run(
    nowIso(),
    userId,
  );
  db.query("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function sessionCookie(sessionId: string, secure: boolean): string {
  const base = `ie_session=${sessionId}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${env.SESSION_TTL_HOURS * 3600}`;
  return secure ? `${base}; Secure` : base;
}

export function readSessionCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)ie_session=([A-Z0-9]+)/);
  if (m?.[1]) return m[1];
  // Bearer fallback for the Chrome extension, which cannot rely on SameSite cookies.
  const auth = req.headers.get("authorization") ?? "";
  const b = auth.match(/^Bearer ([A-Z0-9]+)$/);
  return b?.[1] ?? null;
}
