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
  return db;
}

/** Test-only: fresh in-memory database with the full schema applied. */
export function openTestDb(): Database {
  const mem = new Database(":memory:");
  mem.exec("PRAGMA foreign_keys = ON;");
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  mem.exec(schema.replace("PRAGMA journal_mode = WAL;", ""));
  return mem;
}

export function nowIso(): string {
  return new Date().toISOString();
}
