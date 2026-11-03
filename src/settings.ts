import type { Database } from "./db.ts";
import { nowIso } from "./db.ts";

/**
 * App-wide settings (key/value). Open-source friendly: the product ships OPEN
 * (no login). An admin can turn login on from Settings, which sets require_login.
 */

export async function getSetting(db: Database, key: string): Promise<string | null> {
  const row = await db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export async function setSetting(
  db: Database,
  key: string,
  value: string,
  updatedBy: string | null = null,
): Promise<void> {
  // Shares the app_settings table (key, value, updated_by, updated_at) with calendar settings.
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, value, updatedBy, nowIso());
}

const REQUIRE_LOGIN_KEY = "require_login";

const flag = (v: string | undefined) => ["1", "true", "yes", "on"].includes((v ?? "").trim().toLowerCase());

/**
 * Login is forced on (whatever the in-app toggle says) when:
 * - REQUIRE_LOGIN=true, or
 * - the app runs as a public deployment (VERCEL is set, or NODE_ENV=production),
 *   unless it is the read-only DEMO_MODE showcase or OPEN_ACCESS=true says
 *   otherwise on purpose.
 * Otherwise (a laptop, self-hosted dev) the app stays open until an admin turns
 * login on in Settings. With login forced there is no guest admin at all, so a
 * public URL is never open before someone signs in. First admin: `bun run seed`.
 */
export function loginForcedByEnv(): boolean {
  if (flag(process.env.REQUIRE_LOGIN) || flag(process.env.HOSTED_MODE)) return true;
  if (flag(process.env.DEMO_MODE) || flag(process.env.OPEN_ACCESS)) return false;
  return !!process.env.VERCEL || process.env.NODE_ENV === "production";
}

export async function authRequired(db: Database): Promise<boolean> {
  if (loginForcedByEnv()) return true;
  return await getSetting(db, REQUIRE_LOGIN_KEY) === "true";
}

export async function setAuthRequired(db: Database, on: boolean, updatedBy: string | null = null): Promise<void> {
  await setSetting(db, REQUIRE_LOGIN_KEY, on ? "true" : "false", updatedBy);
}
