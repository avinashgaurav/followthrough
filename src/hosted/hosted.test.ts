import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openTestDb, setDb, withTenant, type Database } from "../db.ts";
import { env } from "../config.ts";
import { handleApi } from "../app.ts";
import { setAuthFetch } from "./routes.ts";
import type { FetchLike } from "./supabase-auth.ts";
import { blobKeyAllowed, newBlobKey } from "../ingest/media.ts";
import { hostedSpendLedger } from "../llm/provider.ts";
import { localStore, sweepOrphanUploads } from "../storage.ts";
import { ulid } from "../ids.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignupsFullError,
  assertExtensionsReady,
  createWorkspace,
  controlRateLimited,
  migrateAllWorkspaces,
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
// Link sign-in: tokens are JWT-shaped; the fake Supabase "validates" any token
// starting with "valid." and describes the user from its payload.
interface FakeLinkUser {
  email?: string;
  confirmed?: boolean;
  provider?: string;
  amr?: string;
  signedInAgoMs?: number;
}
const linkToken = (u: FakeLinkUser) =>
  `valid.${Buffer.from(JSON.stringify({ amr: [{ method: u.amr ?? "otp", timestamp: 1 }], ...u })).toString("base64url")}.sig`;
const supabase: FetchLike & { sent: string[]; redirects: string[] } = Object.assign(
  async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    if (url.endsWith("/auth/v1/user")) {
      const token = (init.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!token.startsWith("valid.")) return { ok: false, status: 401, text: async () => "{}" };
      const u = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as FakeLinkUser;
      const user = {
        email: u.email,
        email_confirmed_at: u.confirmed === false ? null : "2026-11-04T00:00:00Z",
        last_sign_in_at: new Date(Date.now() - (u.signedInAgoMs ?? 5_000)).toISOString(),
        app_metadata: { provider: u.provider ?? "email" },
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(user) };
    }
    const body = JSON.parse(init.body ?? "{}") as { email: string; token?: string };
    if (url.includes("/auth/v1/otp")) {
      supabase.sent.push(body.email);
      supabase.redirects.push(new URL(url).searchParams.get("redirect_to") ?? "");
      return { ok: true, status: 200, text: async () => "{}" };
    }
    const ok = /^\d{5}1$/.test(body.token ?? "");
    return { ok, status: ok ? 200 : 403, text: async () => "{}" };
  },
  { sent: [] as string[], redirects: [] as string[] },
);

beforeAll(async () => {
  db = await openTestDb();
  setDb(db);
  await migrateControl(db);
  env.HOSTED_MODE = "true";
  env.SUPABASE_URL = "https://example.supabase.co";
  env.SUPABASE_ANON_KEY = "anon";
  env.APP_URL = "http://localhost";
  env.MAX_WORKSPACES = 1000;
  env.FREE_MEETINGS_PER_WORKSPACE = 5;
  setAuthFetch(supabase);
});

afterAll(() => {
  // Keys that were absent before must be removed, not left at test values:
  // other test files share this env object.
  for (const k of Object.keys(env) as (keyof typeof env)[]) {
    if (!(k in saved)) delete (env as Record<string, unknown>)[k];
  }
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

  test("a workspace never resolves tables in public", async () => {
    const a = await signedIn("public-probe");
    await db.exec("CREATE TABLE IF NOT EXISTS public.probe_secret (v TEXT); INSERT INTO public.probe_secret VALUES ('leak');");
    await expect(withTenant(a.ws.schema_name, () => db.query("SELECT v FROM probe_secret").all())).rejects.toThrow();
    await db.exec("DROP TABLE public.probe_secret;");
  });

  test("citext is ready in the extensions schema", async () => {
    await assertExtensionsReady(db);
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

describe("review fixes", () => {
  async function verifyAs(who: string) {
    const r = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "222221" } }));
    return { res: r, body: (await r.json()) as { ok?: true; needs_workspace?: boolean; signup_token?: string; invite?: { workspace: string; invited_by: string } } };
  }

  test("an invite never signs the invitee in by itself; they must accept", async () => {
    const a = await signedIn("inv-a");
    const victim = email("victim");
    expect((await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: victim, name: "V" } }))).status).toBe(201);
    const v = await verifyAs(victim);
    expect(cookieOf(v.res)).toBe("");
    expect(v.body.invite?.workspace).toBe("inv-a Inc");
    expect(v.body.signup_token).toBeTruthy();
    const acc = await handleApi(req("POST", "/api/hosted/accept-invite", { body: { signup_token: v.body.signup_token } }));
    expect(acc.status).toBe(200);
    const me = (await (await handleApi(req("GET", "/api/me", { cookie: cookieOf(acc) }))).json()) as { user: { email: string } };
    expect(me.user.email).toBe(victim);
    // Accepted: the next sign-in goes straight in.
    const again = await verifyAs(victim);
    expect(cookieOf(again.res)).not.toBe("");
  });

  test("an invitee can decline by creating their own workspace", async () => {
    const a = await signedIn("dec-a");
    const who = email("decliner");
    await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: who, name: "D" } }));
    const v = await verifyAs(who);
    const c = await handleApi(req("POST", "/api/hosted/create-workspace", { body: { signup_token: v.body.signup_token, product_name: "Mine" } }));
    expect(c.status).toBe(201);
    const ws = (await (await handleApi(req("GET", "/api/hosted/workspace", { cookie: cookieOf(c) }))).json()) as { product_name: string };
    expect(ws.product_name).toBe("Mine");
  });

  test("revoking a teammate frees their email", async () => {
    const a = await signedIn("rev-a");
    const mate = email("revoked");
    const added = (await (await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: mate, name: "M" } }))).json()) as { id: string };
    expect((await handleApi(req("POST", `/api/users/${added.id}/revoke`, { cookie: a.cookie }))).status).toBe(200);
    const row = await db.query("SELECT COUNT(*) AS n FROM control.members WHERE email = ?").get(mate);
    expect((row as { n: number }).n).toBe(0);
  });

  test("parallel requests cannot slip past a rate limit", async () => {
    const key = `race-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => controlRateLimited(db, key, 5, 60_000)));
    expect(results.filter((limited) => !limited).length).toBeLessThanOrEqual(5);
  });

  test("each workspace has its own daily AI cap inside the global one", async () => {
    const a = await signedIn("cap-a");
    const b = await signedIn("cap-b");
    const ledger = hostedSpendLedger(() => db, 1);
    const day = `2099-01-${String(seq % 28).padStart(2, "0")}`;
    expect(await withTenant(a.ws.schema_name, () => ledger.reserve(day, 0.8, 100))).toBe(true);
    expect(await withTenant(a.ws.schema_name, () => ledger.reserve(day, 0.5, 100))).toBe(false);
    expect(await withTenant(b.ws.schema_name, () => ledger.reserve(day, 0.5, 100))).toBe(true);
    // The refused reservation was never charged to the global tally.
    expect(await ledger.spent(day)).toBeCloseTo(1.3);
  });

  test("a workspace whose schema is missing gets no access and is never migrated into a shared schema", async () => {
    const a = await signedIn("gone");
    await db.exec(`DROP SCHEMA ${a.ws.schema_name} CASCADE;`);
    expect((await handleApi(req("GET", "/api/clients", { cookie: a.cookie }))).status).toBe(401);
    await migrateAllWorkspaces(db);
    await assertExtensionsReady(db); // no tables appeared in extensions
  });

  test("operator-credential routes are blocked and bad share URLs are a 404", async () => {
    const a = await signedIn("block2");
    expect((await handleApi(req("POST", "/api/releases/poll", { cookie: a.cookie }))).status).toBe(404);
    expect((await handleApi(req("GET", "/api/calendar/events", { cookie: a.cookie }))).status).toBe(404);
    expect((await handleApi(req("GET", "/share/%E0%A4%A"))).status).toBe(404);
  });
});

describe("hosted orphan-upload sweep", () => {
  test("only touches the workspace's own folder and keeps files its meetings use", async () => {
    const a = await signedIn("sweep-a");
    const b = await signedIn("sweep-b");
    const store = localStore(mkdtempSync(join(tmpdir(), "ft-sweep-")));
    const old = Date.now() - 3 * 86_400_000;
    const orphanA = `${a.ws.id}/${ulid(old)}/orphan.webm`;
    const keptA = `${a.ws.id}/${ulid(old)}/kept.webm`;
    const fileB = `${b.ws.id}/${ulid(old)}/b.webm`;
    for (const k of [orphanA, keptA, fileB]) await store.put(k, new Uint8Array([1]), null);
    await withTenant(a.ws.schema_name, () =>
      db
        .query(
          `INSERT INTO media_assets (id, kind, storage_backend, storage_ref, filename, content_type, size_bytes, sha256, uploaded_by, created_at)
           VALUES (?, 'audio', 'local', ?, 'kept.webm', NULL, 1, 'x', NULL, ?)`,
        )
        .run(ulid(), keptA, new Date().toISOString()),
    );
    const n = await withTenant(a.ws.schema_name, () => sweepOrphanUploads(db, store, Date.now(), undefined, undefined, a.ws.id));
    expect(n).toBe(1);
    expect(await store.exists(orphanA)).toBe(false);
    expect(await store.exists(keptA)).toBe(true);
    expect(await store.exists(fileB)).toBe(true); // another workspace's file is never considered
  });
});

describe("link sign-in", () => {
  const link = (token: string) => handleApi(req("POST", "/api/hosted/link-verify", { body: { access_token: token } }));

  test("the emailed link returns people to APP_URL/auth/callback, never the request's host", async () => {
    const who = email("link-redirect");
    await handleApi(
      new Request("http://evil.example/api/hosted/send-code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: who }),
      }),
    );
    expect(supabase.redirects.at(-1)).toBe("http://localhost/auth/callback");
  });

  test("without APP_URL, sending a link is refused", async () => {
    const saved = env.APP_URL;
    env.APP_URL = undefined;
    try {
      expect((await handleApi(req("POST", "/api/hosted/send-code", { body: { email: email("noapp") } }))).status).toBe(503);
    } finally {
      env.APP_URL = saved;
    }
  });

  test("a new email: the link leads to naming the workspace, then a session", async () => {
    const who = email("link-new");
    const r = await link(linkToken({ email: who }));
    const body = (await r.json()) as { needs_workspace: boolean; signup_token: string };
    expect(body.needs_workspace).toBe(true);
    expect(cookieOf(r)).toBe("");
    const c = await handleApi(req("POST", "/api/hosted/create-workspace", { body: { signup_token: body.signup_token, product_name: "LinkCo" } }));
    expect(c.status).toBe(201);
    const back = await link(linkToken({ email: who }));
    expect(back.status).toBe(200);
    expect(cookieOf(back)).not.toBe("");
  });

  test("tokens that do not prove the inbox, or are stale, sign nobody in", async () => {
    const who = email("link-bad");
    expect((await link("not-a-real-token-at-all-xyz")).status).toBe(401);
    expect((await link(linkToken({ email: who, confirmed: false }))).status).toBe(401);
    expect((await link(linkToken({ email: who, amr: "password" }))).status).toBe(401);
    expect((await link(linkToken({ email: who, amr: "oauth" }))).status).toBe(401);
    expect((await link(linkToken({ email: who, provider: "google" }))).status).toBe(401);
    expect((await link(linkToken({ email: who, signedInAgoMs: 11 * 60_000 }))).status).toBe(401);
    expect((await link(linkToken({}))).status).toBe(401);
  });

  test("an invite still needs accepting after a link sign-in", async () => {
    const a = await signedIn("link-inv");
    const who = email("link-invitee");
    await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: who, name: "I" } }));
    const r = await link(linkToken({ email: who }));
    const body = (await r.json()) as { invite?: { workspace: string } };
    expect(body.invite?.workspace).toBe("link-inv Inc");
    expect(cookieOf(r)).toBe("");
  });

  test("sign-in POSTs must be JSON and same-origin (no login CSRF)", async () => {
    const form = await handleApi(
      new Request("http://localhost/api/hosted/link-verify", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ access_token: linkToken({ email: email("csrf") }) }),
      }),
    );
    expect(form.status).toBe(415);
    const cross = await handleApi(
      new Request("http://localhost/api/hosted/link-verify", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ access_token: linkToken({ email: email("csrf2") }) }),
      }),
    );
    expect(cross.status).toBe(403);
  });
});
