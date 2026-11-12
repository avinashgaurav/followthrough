import { type Database, nowIso, currentTenant } from "./db.ts";
import { hostedMode } from "./config.ts";
import type { AuthedUser } from "./auth.ts";

/**
 * Personal API tokens (migrations/006_api_tokens.sql), sent as
 * `Authorization: Bearer ftk_<scope>_<secret>`. The scope says where the token
 * lives: a hosted workspace id (so a request can be pinned to that workspace
 * before anything is looked up) or "local" on a single-tenant deployment. Only
 * the SHA-256 of the whole token is stored.
 */

export const MAX_TOKENS_PER_USER = 10;
const TOKEN_RE = /^ftk_([0-9A-Z]{26}|local)_([A-Za-z0-9_-]{43})$/;

export function tokenHash(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function newToken(scope: string): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ftk_${scope}_${Buffer.from(bytes).toString("base64url")}`;
}

/** The bearer token on a request, if it is shaped like one of ours. */
export function bearerToken(req: Request): { token: string; scope: string } | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  if (!m) return null;
  const parsed = TOKEN_RE.exec(m[1]!);
  return parsed ? { token: m[1]!, scope: parsed[1]! } : null;
}

/** This deployment's token scope: the pinned workspace when hosted, else "local". */
export function currentScope(): string | null {
  if (!hostedMode()) return "local";
  const t = currentTenant();
  return t ? t.slice(3).toUpperCase() : null;
}

/**
 * The user behind a bearer token, in the current database scope. A token from
 * another scope (another workspace, or hosted vs local) never matches.
 */
export async function userForBearer(db: Database, req: Request): Promise<AuthedUser | null> {
  const bearer = bearerToken(req);
  if (!bearer || bearer.scope !== currentScope()) return null;
  const hash = tokenHash(bearer.token);
  const row = (await db
    .query(
      `SELECT u.id, u.email, u.name, u.role, t.id AS token_id, t.last_used_at FROM api_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND u.disabled_at IS NULL`,
    )
    .get(hash)) as (AuthedUser & { token_id: string; last_used_at: string | null }) | null;
  if (!row) return null;
  // Record use at most every five minutes, so busy clients do not write on every call.
  if (!row.last_used_at || Date.parse(row.last_used_at) < Date.now() - 5 * 60_000) {
    await db.query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").run(nowIso(), row.token_id);
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}
