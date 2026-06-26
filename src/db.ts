import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./config.ts";

const SCHEMA_PATH = join(import.meta.dir, "..", "schema.sql");

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  mkdirSync(env.DATA_DIR, { recursive: true });
  mkdirSync(env.BLOB_DIR, { recursive: true });
  db = new Database(join(env.DATA_DIR, "insights.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  applyMigrations(db);
  return db;
}

/** Idempotent column additions for databases created before the column
 *  existed (schema.sql only CREATEs IF NOT EXISTS, it cannot ALTER). */
function applyMigrations(d: Database): void {
  const addColumn = (table: string, ddl: string) => {
    try {
      d.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl};`);
    } catch {
      // duplicate column - already migrated
    }
  };
  addColumn("clients", "share_token TEXT");
  // v4 extraction: per-insight attribution + read.
  addColumn("insights", "side TEXT");
  addColumn("insights", "sentiment TEXT");
  addColumn("insights", "intent TEXT");
}

/** Test-only: fresh in-memory database with the full schema applied. */
export function openTestDb(): Database {
  const mem = new Database(":memory:");
  mem.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema.replace("PRAGMA journal_mode = WAL;", ""));
  applyMigrations(mem);
  return mem;
}

export function nowIso(): string {
  return new Date().toISOString();
}
