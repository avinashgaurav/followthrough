import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openTestDb } from "./db.ts";

describe("Supabase lockdown migration", () => {
  test("every app table is in the 900_lockdown list and has row-level security on", async () => {
    const db = await openTestDb();
    const tables = (await db
      .query("SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = current_schema() ORDER BY tablename")
      .all()) as Array<{ tablename: string; rowsecurity: number }>;
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "900_lockdown.sql"), "utf8");
    const listed = new Set([...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
    const missing = tables.filter((t) => !listed.has(t.tablename)).map((t) => t.tablename);
    expect(missing).toEqual([]); // add new tables to migrations/900_lockdown.sql
    expect(tables.filter((t) => !t.rowsecurity).map((t) => t.tablename)).toEqual([]);
    expect(tables.length).toBeGreaterThan(20);
  });
});
