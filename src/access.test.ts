import { afterEach, describe, expect, test } from "bun:test";
import { openTestDb, setDb, type Database } from "./db.ts";
import { loginForcedByEnv } from "./settings.ts";
import { handleApi } from "./app.ts";

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
    process.env.DEMO_MODE = "true";
    expect(loginForcedByEnv()).toBe(false);
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
