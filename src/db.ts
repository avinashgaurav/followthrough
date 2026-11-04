import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import postgres from "postgres";
import { APP_MIGRATIONS } from "./migrations.generated.ts";

/**
 * Postgres access (Supabase in production, PGlite in tests) behind the small
 * query/get/all/run surface the app was written against when it ran on SQLite:
 *
 *   const row = await db.query("SELECT * FROM users WHERE id = ?").get(id);
 *
 * `?` and `?N` placeholders are rewritten to `$N`, so the SQL reads as before.
 * Integer, bigint and numeric results come back as JS numbers and booleans as
 * 1/0, matching what the code expected from SQLite. A transaction runs its
 * callback with every `db.query` inside it bound to the transaction's client.
 */

export type Row = Record<string, any>;
export interface RunResult {
  changes: number;
  rows: Row[];
}
export interface Statement {
  get(...params: unknown[]): Promise<any>;
  all(...params: unknown[]): Promise<any[]>;
  run(...params: unknown[]): Promise<RunResult>;
}
export interface Database {
  query(sql: string): Statement;
  /** Run one or more statements with no parameters (DDL, maintenance). */
  exec(sql: string): Promise<void>;
  /** Atomic block. Nested calls join the outer transaction. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** What each driver must provide: one parameterised query and a transaction. */
interface Executor {
  run(text: string, params: unknown[]): Promise<{ rows: Row[]; affected: number }>;
  exec(sql: string): Promise<void>;
  begin<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}


/** `?` / `?N` placeholders to `$N`, leaving quoted strings, identifiers and comments alone. */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += sql.slice(i, stop);
      i = stop - 1;
    } else if (c === "?") {
      const m = /^\d+/.exec(sql.slice(i + 1));
      if (m) {
        out += `$${m[0]}`;
        i += m[0].length;
      } else {
        out += `$${++n}`;
      }
    } else {
      out += c;
    }
  }
  return out;
}

/** SQLite bound booleans as 1/0 and undefined as NULL; keep that contract. */
function bindable(p: unknown): unknown {
  if (p === undefined) return null;
  if (typeof p === "boolean") return p ? 1 : 0;
  return p;
}

// ---------------------------------------------------------------- workspaces (hosted)

/**
 * Hosted mode keeps each workspace in its own Postgres schema. withTenant()
 * pins everything inside it to that schema: every statement runs in a
 * transaction that first does SET LOCAL search_path, so a pooled connection
 * (Supabase transaction pooler) can never carry one workspace's search_path
 * into another's query, and no query in the app has to name a schema.
 */
const tenantScope = new AsyncLocalStorage<string>();
const TENANT_SCHEMA = /^ws_[a-z0-9]{1,40}$/;

export function withTenant<T>(schema: string, fn: () => Promise<T>): Promise<T> {
  if (!TENANT_SCHEMA.test(schema)) throw new Error(`not a workspace schema: "${schema}"`);
  return tenantScope.run(schema, fn);
}

/** The workspace schema this request is pinned to, or null outside withTenant. */
export function currentTenant(): string | null {
  return tenantScope.getStore() ?? null;
}

function pinSql(schema: string): string {
  // schema is validated by withTenant. Only the workspace and the extensions
  // schema (citext) are on the path: never public, so a workspace can never
  // fall through to tables that live there.
  return `SET LOCAL search_path TO ${schema}, extensions`;
}

function makeDb(root: Executor): Database {
  const scope = new AsyncLocalStorage<Executor>();
  const current = () => scope.getStore() ?? root;
  const exec = async (sql: string, params: unknown[]) => {
    const text = toPgPlaceholders(sql);
    const values = params.map(bindable);
    const tenant = tenantScope.getStore();
    const inTx = scope.getStore();
    if (!tenant || inTx) return current().run(text, values);
    return root.begin(async (tx) => {
      await tx.run(pinSql(tenant), []);
      return tx.run(text, values);
    });
  };
  return {
    query(sql: string): Statement {
      return {
        async get(...params) {
          const r = await exec(sql, params);
          return r.rows[0] ?? null;
        },
        async all(...params) {
          return (await exec(sql, params)).rows;
        },
        async run(...params) {
          const r = await exec(sql, params);
          return { changes: r.affected, rows: r.rows };
        },
      };
    },
    exec: (sql) => {
      const tenant = tenantScope.getStore();
      if (!tenant || scope.getStore()) return current().exec(sql);
      return root.begin(async (tx) => {
        await tx.run(pinSql(tenant), []);
        await tx.exec(sql);
      });
    },
    transaction<T>(fn: () => Promise<T>): Promise<T> {
      if (scope.getStore()) return fn();
      const tenant = tenantScope.getStore();
      return root.begin(async (tx) => {
        if (tenant) await tx.run(pinSql(tenant), []);
        return scope.run(tx, fn);
      });
    },
    close: () => root.close(),
  };
}

// ---------------------------------------------------------------- postgres.js (production)

const asNumber = (x: string) => Number(x);
const PG_TYPES = {
  bigint: { to: 20, from: [20, 1700], serialize: (x: unknown) => String(x), parse: asNumber },
  bool: { to: 16, from: [16], serialize: (x: unknown) => (x ? "t" : "f"), parse: (x: string) => (x === "t" ? 1 : 0) },
};

function postgresExecutor(sql: postgres.Sql | postgres.TransactionSql): Executor {
  return {
    async run(text, params) {
      const res = await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[], { prepare: false });
      return { rows: [...res] as Row[], affected: res.count ?? 0 };
    },
    async exec(text) {
      await sql.unsafe(text);
    },
    begin(fn) {
      return (sql as postgres.Sql).begin((tx) => fn(postgresExecutor(tx))) as Promise<any>;
    },
    async close() {
      if ("end" in sql) await (sql as postgres.Sql).end({ timeout: 5 });
    },
  };
}

/** The pooled Supabase URL (transaction mode) in production; a direct URL also works. */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

/**
 * Optional DB_SCHEMA: run inside a separate Postgres schema (search_path
 * "<schema>, public"), e.g. for a smoke test or preview that must not touch
 * the real tables. Unset in production.
 */
export function dbSchema(): string | null {
  const s = process.env.DB_SCHEMA?.trim();
  if (!s) return null;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) throw new Error(`DB_SCHEMA must be a plain lowercase identifier, got "${s}"`);
  return s;
}

let db: Database | null = null;
let ready: Promise<void> | null = null;

/** The app's database. Call `await migrate()` once at startup (or rely on ensureReady). */
export function getDb(): Database {
  if (db) return db;
  const url = databaseUrl();
  if (!url) throw new Error("DATABASE_URL (or POSTGRES_URL) is not set");
  const sql = postgres(url, {
    prepare: false, // required by the Supabase transaction pooler
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    types: PG_TYPES as any,
    onnotice: () => {},
    ...(dbSchema() ? { connection: { search_path: `${dbSchema()}, public` } } : {}),
  });
  db = makeDb(postgresExecutor(sql));
  return db;
}

/** Applies every migrations/*.sql in name order. Each file is idempotent. */
export async function migrate(target: Database = getDb()): Promise<void> {
  const schema = dbSchema();
  if (schema && target === db) await target.exec(`CREATE SCHEMA IF NOT EXISTS ${schema};`);
  // Embedded (src/migrations.generated.ts): serverless bundles carry no loose .sql files.
  for (const m of APP_MIGRATIONS) {
    await target.exec(m.sql);
  }
}

/** getDb() with the schema applied once per process. */
export async function ensureReady(): Promise<Database> {
  const d = getDb();
  ready ??= migrate(d).catch((e) => {
    ready = null;
    throw e;
  });
  await ready;
  return d;
}

/** Replace the process database (tests, scripts). */
export function setDb(next: Database | null): void {
  db = next;
  ready = next ? Promise.resolve() : null;
}

// ---------------------------------------------------------------- PGlite (tests)

type PgLike = {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(text: string): Promise<unknown>;
  transaction?<T>(fn: (tx: PgLike) => Promise<T>): Promise<T>;
};

let shared: { pg: PgLike; schemas: number; active: string } | null = null;

async function sharedPglite() {
  if (shared) return shared;
  const { PGlite, types } = await import("@electric-sql/pglite");
  const { citext } = await import("@electric-sql/pglite/contrib/citext");
  const pg = await PGlite.create({
    extensions: { citext },
    parsers: {
      [types.INT8]: asNumber,
      [types.NUMERIC]: asNumber,
      [types.BOOL]: (x: string) => (x === "t" ? 1 : 0),
    },
  });
  // Same layout as Supabase: extensions live in their own schema.
  await pg.exec("CREATE SCHEMA IF NOT EXISTS extensions; CREATE EXTENSION IF NOT EXISTS citext SCHEMA extensions;");
  shared = { pg, schemas: 0, active: "public" };
  return shared;
}

/**
 * Test-only: a fresh, empty database with the full schema. One in-process
 * Postgres (PGlite) serves the whole test run; each call gets its own schema,
 * so tests stay isolated without paying for a new Postgres every time.
 */
export async function openTestDb(): Promise<Database> {
  const s = await sharedPglite();
  const schema = `t${++s.schemas}`;
  await s.pg.exec(`CREATE SCHEMA ${schema};`);
  const d = makeDb(schemaExecutor(s, schema));
  await migrate(d);
  return d;
}

/** Runs every statement with search_path set to this test database's schema. */
function schemaExecutor(s: NonNullable<typeof shared>, schema: string, tx?: PgLike): Executor {
  const conn = () => tx ?? s.pg;
  const use = async () => {
    // Inside a transaction the path was set once at begin (and may have been
    // narrowed to a workspace by withTenant); never override it per statement.
    if (tx || s.active === schema) return;
    await conn().exec(`SET search_path TO ${schema}, public, extensions;`);
    s.active = schema;
  };
  return {
    async run(text, params) {
      await use();
      const res = await conn().query(text, params);
      return { rows: res.rows as Row[], affected: res.affectedRows ?? 0 };
    },
    async exec(text) {
      await use();
      await conn().exec(text);
    },
    begin(fn) {
      return s.pg.transaction!(async (t) => {
        await t.exec(`SET LOCAL search_path TO ${schema}, public, extensions;`);
        return fn(schemaExecutor(s, schema, t));
      });
    },
    async close() {},
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
