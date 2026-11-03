import { afterEach, describe, expect, test } from "bun:test";
import { openTestDb, setDb, type Database } from "./db.ts";
import { loginForcedByEnv } from "./settings.ts";
import { handleApi } from "./app.ts";
import { env } from "./config.ts";
import { nowIso } from "./db.ts";
import { ulid } from "./ids.ts";

const KEYS = ["VERCEL", "NODE_ENV", "OPEN_ACCESS", "REQUIRE_LOGIN", "DEMO_MODE"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setDb(null);
});

async function freshApp(): Promise<Database> {
  const db = await openTestDb();
  setDb(db);
  return db;
}
const guests = async (db: Database) =>
  ((await db.query("SELECT COUNT(*) AS n FROM users WHERE id = 'open-access-guest'").get()) as { n: number }).n;

describe("login is required by default on a public deployment", () => {
  test("on Vercel: no guest admin, signed-out requests get 401", async () => {
    process.env.VERCEL = "1";
    expect(loginForcedByEnv()).toBe(true);
    const db = await freshApp();
    const res = await handleApi(new Request("https://app.example/api/me"));
    expect(res.status).toBe(401);
    expect(await guests(db)).toBe(0);
  });

  test("NODE_ENV=production also forces login", () => {
    process.env.NODE_ENV = "production";
    expect(loginForcedByEnv()).toBe(true);
  });

  test("OPEN_ACCESS=true and DEMO_MODE opt out on purpose", () => {
    process.env.VERCEL = "1";
    process.env.OPEN_ACCESS = "true";
    expect(loginForcedByEnv()).toBe(false);
    delete process.env.OPEN_ACCESS;
    const savedDemo = env.DEMO_MODE;
    env.DEMO_MODE = "true"; // the same reading the demo guard uses (config.ts)
    try {
      expect(loginForcedByEnv()).toBe(false);
    } finally {
      env.DEMO_MODE = savedDemo;
    }
  });

  test("REQUIRE_LOGIN wins over OPEN_ACCESS", () => {
    process.env.OPEN_ACCESS = "true";
    process.env.REQUIRE_LOGIN = "true";
    expect(loginForcedByEnv()).toBe(true);
  });

  test("locally (no VERCEL, not production) the app stays open with a guest admin", async () => {
    const db = await freshApp();
    const res = await handleApi(new Request("http://localhost/api/me"));
    expect(res.status).toBe(200);
    expect(await guests(db)).toBe(1);
  });
});

describe("router", () => {
  test("public routes never create a guest", async () => {
    const db = await freshApp();
    expect((await handleApi(new Request("http://localhost/api/health"))).status).toBe(200);
    expect(await guests(db)).toBe(0);
  });

  test("malformed percent-encoding in a path param is a 400, not a crash", async () => {
    await freshApp();
    const res = await handleApi(new Request("http://localhost/api/meetings/%E0%A4%A"));
    expect(res.status).toBe(400);
  });
});

/** An admin with a live session, for routes that need a signed-in admin when login is forced. */
async function adminSession(db: Database): Promise<string> {
  const userId = ulid();
  await db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, 'boss@example.com', 'Boss', 'admin', ?)",
  ).run(userId, nowIso());
  const sessionId = ulid() + ulid();
  await db.query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sessionId,
    userId,
    nowIso(),
    new Date(Date.now() + 3_600_000).toISOString(),
  );
  return sessionId;
}

describe("GET /api/settings/access", () => {
  test("says when the server forces login, so Settings can hide the open toggle", async () => {
    process.env.REQUIRE_LOGIN = "true";
    const db = await freshApp();
    const sid = await adminSession(db);
    const res = await handleApi(
      new Request("http://localhost/api/settings/access", { headers: { cookie: `ie_session=${sid}` } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { require_login: boolean; forced_by_server: boolean };
    expect(body.require_login).toBe(true);
    expect(body.forced_by_server).toBe(true);
  });

  test("locally the toggle is in charge", async () => {
    await freshApp();
    const res = await handleApi(new Request("http://localhost/api/settings/access"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { require_login: boolean; forced_by_server: boolean };
    expect(body.require_login).toBe(false);
    expect(body.forced_by_server).toBe(false);
  });
});

describe("POST /api/users/:id/rotate-code", () => {
  test("re-enables a revoked user with a fresh code", async () => {
    const db = await freshApp();
    const userId = ulid();
    await db.query(
      "INSERT INTO users (id, email, name, role, created_at, disabled_at) VALUES (?, 'gone@example.com', 'Gone', 'member', ?, ?)",
    ).run(userId, nowIso(), nowIso());
    const res = await handleApi(
      new Request(`http://localhost/api/users/${userId}/rotate-code`, { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { loginCode?: string }).loginCode).toBeTruthy();
    const row = (await db.query("SELECT disabled_at, code_hash FROM users WHERE id = ?").get(userId)) as {
      disabled_at: string | null;
      code_hash: string | null;
    };
    expect(row.disabled_at).toBeNull();
    expect(row.code_hash).toBeTruthy();
  });
});
