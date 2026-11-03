import { type Database, migrate } from "../db.ts";
import { hostedMode } from "../config.ts";
import { assertExtensionsReady, migrateAllWorkspaces, migrateControl } from "./tenancy.ts";

/**
 * Brings the database up to date. Single-tenant: migrations/*.sql in the
 * current schema. Hosted: the control registry (which also puts citext in
 * "extensions"), a check of that, then migrations/*.sql in every workspace.
 */
export async function prepareDatabase(db: Database): Promise<string> {
  if (!hostedMode()) {
    await migrate(db);
    return "migrations applied";
  }
  await migrateControl(db);
  await assertExtensionsReady(db);
  const n = await migrateAllWorkspaces(db);
  return `control registry ready; migrations applied to ${n} workspace(s)`;
}
