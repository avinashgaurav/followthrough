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
import { CONTROL_MIGRATIONS } from "../migrations.generated.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SignupsFullError,
  addMember,
  assertExtensionsReady,
  isUnverifiedClaim,
  membershipFor,
  openPasswordSession,
  promoteUnverifiedClaim,
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
// Link sign-in (legacy): tokens are JWT-shaped; the fake Supabase "validates"
// any token starting with "valid." and describes the user from its payload.
// Link sign-in (token hash): "hash-ok:<email>" verifies as that email.
interface FakeLinkUser {
  email?: string;
  confirmed?: boolean;
  provider?: string;
  amr?: string;
  signedInAgoMs?: number;
  issuedAgoMs?: number;
  sessionId?: string;
}
const linkToken = (u: FakeLinkUser) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const claims = {
    amr: [{ method: u.amr ?? "otp", timestamp: nowSec - Math.floor((u.signedInAgoMs ?? 5_000) / 1000) }],
    iat: nowSec - Math.floor((u.issuedAgoMs ?? 5_000) / 1000),
    session_id: u.sessionId ?? ulid(),
    ...u,
  };
  return `valid.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
};
const supabase: FetchLike & { sent: string[]; redirects: string[]; hashTypes: string[] } = Object.assign(
  async (url: string, init: { headers: Record<string, string>; body?: string }) => {
    if (url.endsWith("/auth/v1/user")) {
      const token = (init.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!token.startsWith("valid.")) return { ok: false, status: 401, text: async () => "{}" };
      const u = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as FakeLinkUser;
      const user = {
        email: u.email,
        email_confirmed_at: u.confirmed === false ? null : "2026-11-04T00:00:00Z",
        // Always "just now": the server must not trust it for freshness.
        last_sign_in_at: new Date().toISOString(),
        app_metadata: { provider: u.provider ?? "email" },
      };
      return { ok: true, status: 200, text: async () => JSON.stringify(user) };
    }
    const body = JSON.parse(init.body ?? "{}") as { email: string; token?: string; token_hash?: string; type?: string };
    if (body.token_hash !== undefined) {
      supabase.hashTypes.push(body.type ?? "");
      const m = /^hash-ok:(.+)$/.exec(body.token_hash);
      if (!m) return { ok: false, status: 403, text: async () => "{}" };
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: "x", user: { email: m[1] } }) };
    }
    if (url.includes("/auth/v1/otp")) {
      supabase.sent.push(body.email);
      supabase.redirects.push(new URL(url).searchParams.get("redirect_to") ?? "");
      return { ok: true, status: 200, text: async () => "{}" };
    }
    const ok = /^\d{5}1$/.test(body.token ?? "");
    return { ok, status: ok ? 200 : 403, text: async () => "{}" };
  },
  { sent: [] as string[], redirects: [] as string[], hashTypes: [] as string[] },
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

  test("boot never moves a shared extension and is safe to rerun", async () => {
    // Hosted shares its database with the single-tenant app today: the control
    // migrations may create citext when missing, never ALTER an existing one.
    for (const m of CONTROL_MIGRATIONS) {
      const code = m.sql.replace(/--.*$/gm, "");
      expect(/ALTER\s+EXTENSION/i.test(code)).toBe(false);
    }
    await migrateControl(db);
    await migrateControl(db);
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

  test("parallel sign-ups cannot overshoot MAX_WORKSPACES", async () => {
    const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
    env.MAX_WORKSPACES = n + 2;
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => createWorkspace(db, { email: email(`race-ws-${i}`), productName: "Race" })),
      );
      expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
      expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof SignupsFullError)).toBe(
        true,
      );
      const after = (await db.query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
      expect(after.n).toBe(n + 2);
    } finally {
      env.MAX_WORKSPACES = 1000;
    }
  });

  test("parallel invites cannot overshoot MAX_MEMBERS_PER_WORKSPACE", async () => {
    const a = await signedIn("race-members");
    const savedMax = env.MAX_MEMBERS_PER_WORKSPACE;
    env.MAX_MEMBERS_PER_WORKSPACE = 3; // the admin plus two invites
    try {
      await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) => addMember(db, a.ws.id, email(`race-mate-${i}`), ulid(), "admin")),
      );
      const { n } = (await db.query("SELECT COUNT(*) AS n FROM control.members WHERE workspace_id = ?").get(a.ws.id)) as { n: number };
      expect(n).toBe(3);
    } finally {
      env.MAX_MEMBERS_PER_WORKSPACE = savedMax;
    }
  });

  test("a stranger cannot use up someone's sign-in code allowance", async () => {
    const who = email("code-lock");
    const from = (ip: string, path: string, body: unknown) =>
      handleApi(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
          body: JSON.stringify(body),
        }),
      );
    for (let i = 0; i < 5; i++) expect((await from("203.0.113.50", "/api/hosted/send-code", { email: who })).status).toBe(200);
    expect((await from("203.0.113.50", "/api/hosted/send-code", { email: who })).status).toBe(429);
    // The owner, elsewhere, still gets a code.
    expect((await from("198.51.100.50", "/api/hosted/send-code", { email: who })).status).toBe(200);
    // Same for wrong-code guesses: they lock that IP, not the owner.
    for (let i = 0; i < 10; i++) await from("203.0.113.51", "/api/hosted/verify", { email: who, code: "000000" });
    expect((await from("203.0.113.51", "/api/hosted/verify", { email: who, code: "123451" })).status).toBe(429);
    const owner = await from("198.51.100.51", "/api/hosted/verify", { email: who, code: "123451" });
    expect(owner.status).toBe(200);
  });

  test("parallel requests cannot slip past a rate limit", async () => {
    const key = `race-${Date.now()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => controlRateLimited(db, key, 5, 60_000)));
    expect(results.filter((limited) => !limited).length).toBeLessThanOrEqual(5);
  });

  test("refused requests add no rows once a limit is reached", async () => {
    const key = `flood-${Date.now()}`;
    for (let i = 0; i < 3; i++) await controlRateLimited(db, key, 3, 60_000);
    const rows = async () =>
      ((await db.query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key = ?").get(key)) as { n: number }).n;
    const before = await rows();
    for (let i = 0; i < 10; i++) expect(await controlRateLimited(db, key, 3, 60_000)).toBe(true);
    expect(await rows()).toBe(before);
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
    expect((await link(linkToken({ email: who, issuedAgoMs: 11 * 60_000 }))).status).toBe(401);
    expect((await link(linkToken({}))).status).toBe(401);
  });

  test("legacy tokens: stale or future-dated iat and amr times are refused; fresh ones pass", async () => {
    const a = await signedIn("link-times");
    const who = a.ws.owner_email;
    expect((await link(linkToken({ email: who, issuedAgoMs: 11 * 60_000 }))).status).toBe(401); // stale iat
    expect((await link(linkToken({ email: who, signedInAgoMs: 11 * 60_000 }))).status).toBe(401); // stale amr
    expect((await link(linkToken({ email: who, issuedAgoMs: -120_000 }))).status).toBe(401); // iat 2 min ahead
    expect((await link(linkToken({ email: who, signedInAgoMs: -120_000 }))).status).toBe(401); // amr 2 min ahead
    expect((await link(linkToken({ email: who, issuedAgoMs: -30_000 }))).status).toBe(200); // small skew is fine
    expect((await link(linkToken({ email: who, amr: "password" }))).status).toBe(401); // password session
  });

  test("an email/signup session (Confirm email off: no inbox proof) signs nobody in", async () => {
    // POST /auth/v1/signup with the public anon key yields this amr for any address.
    const victim = await signedIn("link-signup-victim");
    const r = await link(linkToken({ email: victim.ws.owner_email, amr: "email/signup" }));
    expect(r.status).toBe(401);
    expect(cookieOf(r)).toBe("");
  });

  test("a link signs in once: replaying the same session or token hash is refused", async () => {
    const a = await signedIn("link-once");
    const token = linkToken({ email: a.ws.owner_email });
    expect((await link(token)).status).toBe(200);
    expect((await link(token)).status).toBe(401);
    // A fresh token from the same Supabase session is the same sign-in.
    const sessionId = ulid();
    expect((await link(linkToken({ email: a.ws.owner_email, sessionId }))).status).toBe(200);
    expect((await link(linkToken({ email: a.ws.owner_email, sessionId }))).status).toBe(401);
    const hash = { token_hash: `hash-ok:${a.ws.owner_email}`, type: "email" };
    const first = await handleApi(req("POST", "/api/hosted/link-verify", { body: hash }));
    expect(first.status).toBe(200);
    expect(cookieOf(first)).not.toBe("");
    expect((await handleApi(req("POST", "/api/hosted/link-verify", { body: hash }))).status).toBe(401);
  });

  test("a legacy link whose sign-in fails on our side can be retried; a token hash cannot", async () => {
    const token = linkToken({ email: email("link-retry") });
    const hash = { token_hash: `hash-ok:${email("link-retry-hash")}` };
    await db.exec("ALTER TABLE control.pending_signups RENAME TO pending_away;");
    try {
      expect((await link(token)).status).toBe(500);
      expect((await handleApi(req("POST", "/api/hosted/link-verify", { body: hash }))).status).toBe(500);
    } finally {
      await db.exec("ALTER TABLE control.pending_away RENAME TO pending_signups;");
    }
    expect((await link(token)).status).toBe(200);
    // Supabase already spent the hash, so it stays used here too.
    expect((await handleApi(req("POST", "/api/hosted/link-verify", { body: hash }))).status).toBe(401);
  });

  test("token-hash links are checked with Supabase on the server; odd types are refused", async () => {
    const who = email("link-hash");
    const r = await handleApi(req("POST", "/api/hosted/link-verify", { body: { token_hash: `hash-ok:${who}` } }));
    expect(((await r.json()) as { needs_workspace?: boolean }).needs_workspace).toBe(true);
    expect(supabase.hashTypes.at(-1)).toBe("email");
    expect((await handleApi(req("POST", "/api/hosted/link-verify", { body: { token_hash: "hash-bad-0000" } }))).status).toBe(401);
    const recovery = await handleApi(
      req("POST", "/api/hosted/link-verify", { body: { token_hash: `hash-ok:${email("link-rec")}`, type: "recovery" } }),
    );
    expect(recovery.status).toBe(401);
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

describe("email + password sign-up", () => {
  const signup = (body: Record<string, unknown>) => handleApi(req("POST", "/api/hosted/password-signup", { body }));
  const login = (body: Record<string, unknown>) => handleApi(req("POST", "/api/hosted/password-login", { body }));
  const PW = "correct horse battery";

  test("create an account: workspace and session at once, then sign in again", async () => {
    const who = email("pw-new");
    const r = await signup({ email: who, password: PW, product_name: "PassCo", product_description: "a test" });
    expect(r.status).toBe(201);
    const me = (await (await handleApi(req("GET", "/api/me", { cookie: cookieOf(r) }))).json()) as { user: { email: string; role: string } };
    expect(me.user.email).toBe(who);
    expect(me.user.role).toBe("admin");
    const ws = (await (await handleApi(req("GET", "/api/hosted/workspace", { cookie: cookieOf(r) }))).json()) as { product_name: string };
    expect(ws.product_name).toBe("PassCo");
    const back = await login({ email: who.toUpperCase(), password: PW });
    expect(back.status).toBe(200);
    expect(cookieOf(back)).not.toBe("");
  });

  test("wrong password and unknown email get the same answer", async () => {
    const who = email("pw-wrong");
    await signup({ email: who, password: PW, product_name: "W" });
    const wrong = await login({ email: who, password: "not the password" });
    const unknown = await login({ email: email("pw-nobody"), password: PW });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  test("an email that already has an account cannot be claimed again", async () => {
    const who = email("pw-dup");
    expect((await signup({ email: who, password: PW, product_name: "A" })).status).toBe(201);
    expect((await signup({ email: who, password: "another password", product_name: "B" })).status).toBe(409);
    expect((await login({ email: who, password: "another password" })).status).toBe(401);
  });

  test("an email with a pending invite (or a link-made account) cannot be claimed by password", async () => {
    const a = await signedIn("pw-inv");
    const invited = email("pw-invitee");
    await handleApi(req("POST", "/api/users", { cookie: a.cookie, body: { email: invited, name: "I" } }));
    expect((await signup({ email: invited, password: PW, product_name: "Squat" })).status).toBe(409);
    expect((await signup({ email: a.ws.owner_email, password: PW, product_name: "Squat" })).status).toBe(409);
  });

  test("short passwords and missing names are refused", async () => {
    expect((await signup({ email: email("pw-short"), password: "short", product_name: "S" })).status).toBe(400);
    expect((await signup({ email: email("pw-noname"), password: PW, product_name: "" })).status).toBe(400);
  });

  const loginFrom = (ip: string, body: Record<string, unknown>) =>
    handleApi(
      new Request("http://localhost/api/hosted/password-login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }),
    );

  test("failed guesses lock that email from that IP only; the owner elsewhere still gets in", async () => {
    const who = email("pw-guess");
    await signup({ email: who, password: PW, product_name: "G" });
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await loginFrom("203.0.113.7", { email: who, password: `guess-${i}-xxxx` })).status;
    expect(last).toBe(401);
    expect((await loginFrom("203.0.113.7", { email: who, password: PW })).status).toBe(429);
    expect((await loginFrom("198.51.100.9", { email: who, password: PW })).status).toBe(200);
  });

  test("once locked out, more guesses add no rate-limit rows", async () => {
    const who = email("pw-flood");
    await signup({ email: who, password: PW, product_name: "F" });
    for (let i = 0; i < 11; i++) await loginFrom("203.0.113.8", { email: who, password: `guess-${i}-xxxx` });
    const rows = async () =>
      ((await db.query("SELECT COUNT(*) AS n FROM control.rate_hits WHERE key LIKE ?").get(`login-fail:${who}%`)) as { n: number }).n;
    const before = await rows();
    for (let i = 0; i < 5; i++) expect((await loginFrom("203.0.113.8", { email: who, password: "more-guesses" })).status).toBe(429);
    expect(await rows()).toBe(before);
  });

  test("successful logins do not count toward a lockout", async () => {
    const who = email("pw-ok-many");
    await signup({ email: who, password: PW, product_name: "OK" });
    for (let i = 0; i < 12; i++) expect((await loginFrom("192.0.2.44", { email: who, password: PW })).status).toBe(200);
  });

  test("proving the inbox promotes a password account: the owner keeps the data, a squatter is out", async () => {
    const who = email("pw-squat");
    const sq = await signup({ email: who, password: PW, product_name: "Squatter" });
    expect(sq.status).toBe(201);
    const made = await handleApi(req("POST", "/api/clients", { cookie: cookieOf(sq), body: { name: "Kept Client" } }));
    expect(made.status).toBe(201);
    const wsId = ((await db.query("SELECT workspace_id FROM control.members WHERE email = ?").get(who)) as { workspace_id: string })
      .workspace_id;
    // Whoever proves the inbox (an owner who forgot the password, or the real
    // owner of a squatted email) gets the account, not a fresh one.
    const r = await handleApi(req("POST", "/api/hosted/link-verify", { body: { token_hash: `hash-ok:${who}` } }));
    expect(r.status).toBe(200);
    const cookie = cookieOf(r);
    expect(cookie).not.toBe("");
    const clients = (await (await handleApi(req("GET", "/api/clients", { cookie }))).json()) as { clients: { name: string }[] };
    expect(clients.clients.map((c) => c.name)).toContain("Kept Client");
    // Nothing was deleted, and the member is now verified.
    expect(await db.query("SELECT 1 AS x FROM control.workspaces WHERE id = ?").get(wsId)).not.toBeNull();
    const m = (await db.query("SELECT verified_at FROM control.members WHERE email = ?").get(who)) as { verified_at: string | null };
    expect(m.verified_at).not.toBeNull();
    // The password and every session opened with it are gone.
    expect((await login({ email: who, password: PW })).status).toBe(401);
    const cred = await db.query("SELECT COUNT(*) AS n FROM control.credentials WHERE email = ?").get(who);
    expect((cred as { n: number }).n).toBe(0);
    expect((await handleApi(req("GET", "/api/clients", { cookie: cookieOf(sq) }))).status).toBe(401);
    // And a later inbox sign-in is an ordinary one.
    const again = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "333331" } }));
    expect(again.status).toBe(200);
    expect(cookieOf(again)).not.toBe("");
  });

  test("promotion also removes anyone the password account let in", async () => {
    const who = email("pw-accomplice-owner");
    const sq = await signup({ email: who, password: PW, product_name: "Planted" });
    const accomplice = email("pw-accomplice");
    expect((await handleApi(req("POST", "/api/users", { cookie: cookieOf(sq), body: { email: accomplice, name: "A" } }))).status).toBe(201);
    const v = await handleApi(req("POST", "/api/hosted/verify", { body: { email: accomplice, code: "555551" } }));
    const vb = (await v.json()) as { signup_token: string };
    const acc = await handleApi(req("POST", "/api/hosted/accept-invite", { body: { signup_token: vb.signup_token } }));
    expect(acc.status).toBe(200);
    // The real owner proves the inbox.
    const r = await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "555561" } }));
    expect(cookieOf(r)).not.toBe("");
    expect((await handleApi(req("GET", "/api/clients", { cookie: cookieOf(acc) }))).status).toBe(401);
    expect(await db.query("SELECT 1 AS x FROM control.members WHERE email = ?").get(accomplice)).toBeNull();
    expect((await handleApi(req("GET", "/api/clients", { cookie: cookieOf(r) }))).status).toBe(200);
  });

  test("promotion turns off client share links the password holder knew", async () => {
    const who = email("pw-share");
    const sq = await signup({ email: who, password: PW, product_name: "Shared" });
    const made = (await (await handleApi(req("POST", "/api/clients", { cookie: cookieOf(sq), body: { name: "Leaky" } }))).json()) as {
      client: { id: string };
    };
    const shared = (await (
      await handleApi(req("POST", `/api/clients/${made.client.id}/share-link`, { cookie: cookieOf(sq) }))
    ).json()) as { url: string };
    expect((await handleApi(req("GET", shared.url))).status).toBe(200);
    await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "666661" } }));
    expect((await handleApi(req("GET", shared.url))).status).toBe(404);
  });

  test("a password login that loses the race to a promotion gets no session", async () => {
    const who = email("pw-race");
    await signup({ email: who, password: PW, product_name: "Race" });
    const m = (await membershipFor(db, who))!;
    // Login checked the password, then the owner proved the inbox before it opened a session.
    expect(await promoteUnverifiedClaim(db, who)).toBe(true);
    expect(await openPasswordSession(db, m.workspace, m.userId, who, { ip: null, userAgent: null })).toBeNull();
  });

  test("the sign-in path never drops a workspace schema", async () => {
    const who = email("pw-nodrop");
    await signup({ email: who, password: PW, product_name: "Kept" });
    const schema = ((await db.query(
      "SELECT w.schema_name FROM control.members m JOIN control.workspaces w ON w.id = m.workspace_id WHERE m.email = ?",
    ).get(who)) as { schema_name: string }).schema_name;
    await handleApi(req("POST", "/api/hosted/verify", { body: { email: who, code: "444441" } }));
    expect(await db.query("SELECT 1 AS x FROM pg_namespace WHERE nspname = ?").get(schema)).not.toBeNull();
  });

  test("promotion is all or nothing", async () => {
    const who = email("pw-atomic");
    await signup({ email: who, password: PW, product_name: "Atomic" });
    const m = (await db.query(
      "SELECT m.user_id, w.schema_name FROM control.members m JOIN control.workspaces w ON w.id = m.workspace_id WHERE m.email = ?",
    ).get(who)) as { user_id: string; schema_name: string };
    // Break the last step: the workspace sessions table is gone.
    await db.exec(`ALTER TABLE ${m.schema_name}.sessions RENAME TO sessions_away;`);
    try {
      await expect(promoteUnverifiedClaim(db, who)).rejects.toThrow();
    } finally {
      await db.exec(`ALTER TABLE ${m.schema_name}.sessions_away RENAME TO sessions;`);
    }
    // The earlier steps rolled back: still unverified, password intact.
    expect(await isUnverifiedClaim(db, who)).toBe(true);
    expect((await login({ email: who, password: PW })).status).toBe(200);
  });

  test("a password only opens the membership it was created with", async () => {
    const who = email("pw-bound");
    await signup({ email: who, password: PW, product_name: "Bound" });
    // Simulate the email ending up attached to a different membership.
    await db.query("UPDATE control.credentials SET user_id = 'SOMEONEELSE' WHERE email = ?").run(who);
    expect((await login({ email: who, password: PW })).status).toBe(401);
  });

  test("an admin cannot revoke themselves (no orphaned password)", async () => {
    const who = email("pw-selfrevoke");
    const r = await signup({ email: who, password: PW, product_name: "Self" });
    const me = (await (await handleApi(req("GET", "/api/me", { cookie: cookieOf(r) }))).json()) as { user: { id: string } };
    expect((await handleApi(req("POST", `/api/users/${me.user.id}/revoke`, { cookie: cookieOf(r) }))).status).toBe(400);
  });

  test("easily guessed passwords are refused", async () => {
    expect((await signup({ email: email("pw-weak"), password: "password123", product_name: "W" })).status).toBe(400);
    // From the bundled common-password list, matched case-insensitively.
    expect((await signup({ email: email("pw-weak2"), password: "BasketBall", product_name: "W" })).status).toBe(400);
    expect((await signup({ email: email("pw-weak3"), password: "1q2w3e4r5t", product_name: "W" })).status).toBe(400);
    const who = email("longlocalpart");
    expect((await signup({ email: who, password: `${who.split("@")[0]}!!`, product_name: "W" })).status).toBe(400);
  });

  test("an invalid email gets its own message", async () => {
    const r = await signup({ email: "a@b", password: PW, product_name: "X" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("Enter a valid email address.");
  });

  test("sign-ups paused by the operator's trigger answer 503 with its message", async () => {
    await db.exec(`
      CREATE OR REPLACE FUNCTION control.test_pause() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Sign-ups are paused for maintenance.'; END $$;
      CREATE TRIGGER test_pause BEFORE INSERT ON control.workspaces FOR EACH ROW EXECUTE FUNCTION control.test_pause();`);
    try {
      const r = await signup({ email: email("pw-paused"), password: PW, product_name: "Paused" });
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: string }).error).toBe("Sign-ups are paused for maintenance.");
    } finally {
      await db.exec("DROP TRIGGER test_pause ON control.workspaces; DROP FUNCTION control.test_pause();");
    }
  });

  test("cross-site sign-up is refused", async () => {
    const r = await handleApi(
      new Request("http://localhost/api/hosted/password-signup", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://evil.example" },
        body: JSON.stringify({ email: email("pw-csrf"), password: PW, product_name: "X" }),
      }),
    );
    expect(r.status).toBe(403);
  });
});
