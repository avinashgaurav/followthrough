import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDb, setDb, withTenant, type Database } from "../db.ts";
import { env } from "../config.ts";
import { handleApi } from "../app.ts";
import { setAuthFetch } from "./routes.ts";
import type { FetchLike } from "./supabase-auth.ts";
import { blobKeyAllowed, newBlobKey } from "../ingest/media.ts";
import {
  SignupsFullError,
  assertPublicHasNoAppTables,
  createWorkspace,
  migrateControl,
  openSession,
  refundMeeting,
  reserveMeeting,
  type Workspace,
} from "./tenancy.ts";

let db: Database;
const saved = { ...env };
let seq = 0;
const email = (tag: string) => `${tag}-${++seq}-${Date.now()}@example.com`;

// Fake Supabase Auth: any 6-digit code ending in 1 is valid.
const supabase: FetchLike & { sent: string[] } = Object.assign(
  async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as { email: string; token?: string };
    if (url.endsWith("/auth/v1/otp")) {
      supabase.sent.push(body.email);
      return { ok: true, status: 200, text: async () => "{}" };
    }
    const ok = /^\d{5}1$/.test(body.token ?? "");
    return { ok, status: ok ? 200 : 403, text: async () => "{}" };
  },
  { sent: [] as string[] },
);

beforeAll(async () => {
  db = await openTestDb();
  setDb(db);
  await migrateControl(db);
  env.HOSTED_MODE = "true";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_ANON_KEY = "anon";
  env.MAX_WORKSPACES = 1000;
  env.FREE_MEETINGS_PER_WORKSPACE = 5;
  setAuthFetch(supabase);
});

afterAll(() => {
  Object.assign(env, saved);
  setAuthFetch(undefined);
  setDb(null);
});

const req = (method: string, path: string, opts: { body?: unknown; cookie?: string } = {}) =>
  new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.0.${seq % 250}.${(Date.now() % 250) + 1}`,
      ...(opts.cookie ? { cookie: `ie_session=${opts.cookie}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });

const cookieOf = (res: Response) => /ie_session=([A-Z0-9]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";

async function signedIn(tag: string): Promise<{ ws: Workspace; cookie: string }> {
  const { workspace, userId } = await createWorkspace(db, { email: email(tag), productName: `${tag} Inc` });
  const cookie = await openSession(db, workspace, userId, { ip: null, userAgent: null });
  return { ws: workspace, cookie };
}

describe("workspace isolation", () => {
  test("a workspace's rows are invisible to another workspace and to the shared schema", async () => {
    const a = await signedIn("iso-a");
    const b = await signedIn("iso-b");
    const made = await handleApi(req("POST", "/api/clients", { cookie: a.cookie, body: { name: "Acme Secret Client" } }));
    expect(made.status).toBe(201);

    const asA = (await (await handleApi(req("GET", "/api/clients", { cookie: a.cookie }))).json()) as { clients: { name: string }[] };
    const asB = (await (await handleApi(req("GET", "/api/clients", { cookie: b.cookie }))).json()) as { clients: { name: string }[] };
    expect(asA.clients.map((c) => c.name)).toContain("Acme Secret Client");
    expect(asB.clients).toHaveLength(0);

    // Directly: the row lives only in A's schema.
    const inB = await withTenant(b.ws.schema_name, () => db.query("SELECT COUNT(*) AS n FROM clients").get());
    expect((inB as { n: number }).n).toBe(0);
  });

  test("a transaction stays pinned to its workspace", async () => {
    const a = await signedIn("tx-a");
    const b = await signedIn("tx-b");
    await withTenant(a.ws.schema_name, () =>
      db.transaction(async () => {
        await db.query("INSERT INTO tags (id, name, kind) VALUES ('t1', 'only-in-a', 'freeform')").run();
      }),
    );
    const inB = await withTenant(b.ws.schema_name, () => db.query("SELECT COUNT(*) AS n FROM tags WHERE name = 'only-in-a'").get());
    const inA = await withTenant(a.ws.schema_name, () => db.query("SELECT COUNT(*) AS n FROM tags WHERE name = 'only-in-a'").get());
    expect((inB as { n: number }).n).toBe(0);
    expect((inA as { n: number }).n).toBe(1);
  });

  test("no session, an unknown session, or another app's cookie gets 401, never data", async () => {
    expect((await handleApi(req("GET", "/api/clients"))).status).toBe(401);
    expect((await handleApi(req("GET", "/api/clients", { cookie: "01AAAAAAAAAAAAAAAAAAAAAAAA" }))).status).toBe(401);
  });

  test("withTenant refuses anything that is not a workspace schema", () => {
    expect(() => withTenant("public", async () => 1)).toThrow();
    expect(() => withTenant("ws_a; DROP SCHEMA x", async () => 1)).toThrow();
  });

  test("public holding app tables is refused", async () => {
    await expect(
      db.transaction(async () => {
        await db.exec("CREATE TABLE public.insights (id TEXT);");
        await assertPublicHasNoAppTables(db);
      }),
    ).rejects.toThrow(/public schema/);
    await assertPublicHasNoAppTables(db); // rolled back
  });
});

describe("sign-up and sign-in", () => {
  test("new email: code, name the workspace, signed in; then a plain sign-in", async () => {
    const who = email("signup");
    expect((await handleApi(req("POST", "/api/hosted/send-code", { body: { email: who } }))).status).toBe(200);
    expect(supabase.sent).toContain(who);

    const bad = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "123450" } }));
    expect(bad.status).toBe(401);

    const v = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "123451" } }));
    const vb = (await v.json()) as { needs_workspace: boolean; signup_token: string };
    expect(vb.needs_workspace).toBe(true);
    expect(cookieOf(v)).toBe("");

    const c = await handleApi(
      req("POST", "/api/hosted/create-workspace", {
        body: { signup_token: vb.signup_token, product_name: "Beacon", product_description: "a B2B analytics tool" },
      }),
    );
    expect(c.status).toBe(201);
    const cookie = cookieOf(c);
    expect(cookie).not.toBe("");

    const me = (await (await handleApi(req("GET", "/api/me", { cookie }))).json()) as { user: { email: string; role: string }; hosted: boolean };
    expect(me.user.email).toBe(who);
    expect(me.user.role).toBe("admin");
    expect(me.hosted).toBe(true);

    const ws = (await (await handleApi(req("GET", "/api/hosted/workspace", { cookie }))).json()) as { product_name: string; meetings_quota: number };
    expect(ws.product_name).toBe("Beacon");
    expect(ws.meetings_quota).toBe(5);

    // The sign-up token is single use.
    const again = await handleApi(req("POST", "/api/hosted/create-workspace", { body: { signup_token: vb.signup_token, product_name: "X" } }));
    expect(again.status).toBe(401);

    // Returning user goes straight in.
    const back = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "999991" } }));
    expect(back.status).toBe(200);
    expect(cookieOf(back)).not.toBe("");
  });

  test("sign-ups stop at MAX_WORKSPACES", async () => {
    const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
    env.MAX_WORKSPACES = n;
    try {
      await expect(createWorkspace(db, { email: email("full"), productName: "Late" })).rejects.toBeInstanceOf(SignupsFullError);
    } finally {
      env.MAX_WORKSPACES = 1000;
    }
  });

  test("an added teammate is registered to the workspace and cannot join a second one", async () => {
    const a = await signedIn("team-a");
    const mate = email("mate");
    const add = await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: mate, name: "Mate" } }));
    expect(add.status).toBe(201);
    const b = await signedIn("team-b");
    const dup = await handleApi(req("POST", "/api/users", { cookie: b.cookie, body: { email: mate, name: "Mate" } }));
    expect(dup.status).toBe(409);
    const inB = await withTenant(b.ws.schema_name, () => db.query("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(mate));
    expect((inB as { n: number }).n).toBe(0);
  });

  test("single-tenant routes are off", async () => {
    const a = await signedIn("blocked");
    expect((await handleApi(req("POST", "/api/auth/login", { body: { email: "x@y.z", code: "abc" } }))).status).toBe(404);
    expect((await handleApi(req("GET", "/api/watchfolder/status", { cookie: a.cookie }))).status).toBe(404);
  });
});

describe("free meeting quota", () => {
  test("reserves until the quota, then refuses; a refund frees one", async () => {
    const { ws } = await signedIn("quota");
    await db.query("UPDATE control.workspaces SET meetings_quota = 2 WHERE id = ?").run(ws.id);
    expect(await reserveMeeting(db, ws.id)).toBe(true);
    expect(await reserveMeeting(db, ws.id)).toBe(true);
    expect(await reserveMeeting(db, ws.id)).toBe(false);
    await refundMeeting(db, ws.id);
    expect(await reserveMeeting(db, ws.id)).toBe(true);
  });

  test("creating a meeting past the quota returns 402 and does not create it", async () => {
    const a = await signedIn("quota-route");
    await db.query("UPDATE control.workspaces SET meetings_quota = 0 WHERE id = ?").run(a.ws.id);
    const client = (await (await handleApi(req("POST", "/api/clients", { cookie: a.cookie, body: { name: "C" } }))).json()) as {
      client: { id: string };
    };
    const form = new FormData();
    form.set("client_id", client.client.id);
    form.set("meeting_date", "2026-11-01");
    form.set("consent_confirmed", "true");
    form.set("transcript_text", "Speaker 0: hello");
    const res = await handleApi(
      new Request("http://localhost/api/meetings", { method: "POST", headers: { cookie: `ie_session=${a.cookie}` }, body: form }),
    );
    expect(res.status).toBe(402);
    const n = await withTenant(a.ws.schema_name, () => db.query("SELECT COUNT(*) AS n FROM meetings").get());
    expect((n as { n: number }).n).toBe(0);
  });
});

describe("client share page", () => {
  test("the token names its workspace; it only opens there", async () => {
    const a = await signedIn("share-a");
    const b = await signedIn("share-b");
    const made = (await (await handleApi(req("POST", "/api/clients", { cookie: a.cookie, body: { name: "Shared Co" } }))).json()) as {
      client: { id: string };
    };
    const link = (await (await handleApi(req("POST", `/api/clients/${made.client.id}/share-link`, { cookie: a.cookie }))).json()) as {
      url: string;
    };
    expect(link.url.startsWith(`/share/${a.ws.id}.`)).toBe(true);
    const page = await handleApi(req("GET", link.url));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Shared Co");

    const secret = link.url.split(".")[1]!;
    expect((await handleApi(req("GET", `/share/${b.ws.id}.${secret}`))).status).toBe(404);
    expect((await handleApi(req("GET", `/share/NOTAWORKSPACE.${secret}`))).status).toBe(404);
  });
});

describe("upload keys", () => {
  test("a workspace mints keys under its own prefix and refuses another workspace's", async () => {
    const a = await signedIn("keys-a");
    const b = await signedIn("keys-b");
    const keyA = await withTenant(a.ws.schema_name, async () => newBlobKey("call.webm"));
    expect(keyA.startsWith(`${a.ws.id}/`)).toBe(true);
    expect(await withTenant(a.ws.schema_name, async () => blobKeyAllowed(keyA))).toBe(true);
    expect(await withTenant(b.ws.schema_name, async () => blobKeyAllowed(keyA))).toBe(false);
    // An unprefixed (self-hosted style) key is refused in hosted mode.
    expect(await withTenant(a.ws.schema_name, async () => blobKeyAllowed(keyA.slice(a.ws.id.length + 1)))).toBe(false);
  });
});
