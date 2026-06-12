import type { Database } from "bun:sqlite";
import { nowIso } from "./db.ts";

/**
 * App-wide settings (key/value). Open-source friendly: the product ships OPEN
 * (no login). An admin can turn login on from Settings, which sets require_login.
 */

export function getSetting(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as
    | { value: string }
    | null;
  return row?.value ?? null;
}

export function setSetting(
  db: Database,
  key: string,
  value: string,
  updatedBy: string | null = null,
): void {
  // Shares the app_settings table (key, value, updated_by, updated_at) with calendar settings.
  db.query(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(key, value, updatedBy, nowIso());
}

const REQUIRE_LOGIN_KEY = "require_login";

/** Default false: the app is open until an admin turns login on. */
export function authRequired(db: Database): boolean {
  return getSetting(db, REQUIRE_LOGIN_KEY) === "true";
}

export function setAuthRequired(db: Database, on: boolean, updatedBy: string | null = null): void {
  setSetting(db, REQUIRE_LOGIN_KEY, on ? "true" : "false", updatedBy);
}
