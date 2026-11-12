import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openTestDb, setDb, nowIso, type Database } from "./db.ts";
import { handleApi } from "./app.ts";
import { ulid } from "./ids.ts";
import { TOOLS } from "./mcp.ts";

let db: Database;
const savedLogin = process.env.REQUIRE_LOGIN;

beforeEach(async () => {
  process.env.REQUIRE_LOGIN = "true";
  db = await openTestDb();
  setDb(db);
});
afterEach(() => {
  if (savedLogin === undefined) delete process.env.REQUIRE_LOGIN;
  else process.env.REQUIRE_LOGIN = savedLogin;
  setDb(null);
});

async function signedInUser(role: "admin" | "member" = "admin"): Promise<{ id: string; email: string; cookie: string }> {
  const id = ulid();
  const email = `${role}-${id.toLowerCase()}@tallyhall.com`;
  await db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(id, email, "Maya", role, nowIso());
  const sid = ulid();
  await db
    .query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(sid, id, nowIso(), new Date(Date.now() + 3_600_000).toISOString());
  return { id, email, cookie: `ie_session=${sid}` };
}

const api = (method: string, path: string, opts: { cookie?: string; bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  handleApi(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
  );

async function makeToken(cookie: string): Promise<{ id: string; token: string }> {
  const r = await api("POST", "/api/tokens", { cookie, body: { name: "Claude" } });
  expect(r.status).toBe(201);
  return (await r.json()) as { id: string; token: string };
}

let rpcId = 0;
async function rpc(bearer: string | undefined, method: string, params?: unknown, headers?: Record<string, string>) {
  const r = await api("POST", "/api/mcp", { bearer, body: { jsonrpc: "2.0", id: ++rpcId, method, params }, headers });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as { result?: any; error?: { code: number; message: string } }) : null };
}
const callTool = async (bearer: string, name: string, args: Record<string, unknown> = {}) =>
  (await rpc(bearer, "tools/call", { name, arguments: args })).body!.result as { content: { text: string }[]; isError?: boolean };

describe("personal API tokens", () => {
  test("made from a signed-in browser, shown once, listed without the secret", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    expect(token).toMatch(/^ftk_local_[A-Za-z0-9_-]{43}$/);
    const list = (await (await api("GET", "/api/tokens", { cookie: u.cookie })).json()) as { tokens: Record<string, unknown>[] };
    expect(list.tokens).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  test("a token cannot make or revoke tokens", async () => {
    const u = await signedInUser();
    const { id, token } = await makeToken(u.cookie);
    expect((await api("POST", "/api/tokens", { bearer: token, body: { name: "x" } })).status).toBe(403);
    expect((await api("POST", `/api/tokens/${id}/revoke`, { bearer: token })).status).toBe(403);
  });

  test("a revoked token, or one whose user is disabled, stops working", async () => {
    const u = await signedInUser();
    const a = await makeToken(u.cookie);
    expect((await api("GET", "/api/me", { bearer: a.token })).status).toBe(200);
    expect((await api("POST", `/api/tokens/${a.id}/revoke`, { cookie: u.cookie })).status).toBe(200);
    expect((await api("GET", "/api/me", { bearer: a.token })).status).toBe(401);
    const b = await makeToken(u.cookie);
    await db.query("UPDATE users SET disabled_at = ? WHERE id = ?").run(nowIso(), u.id);
    expect((await api("GET", "/api/me", { bearer: b.token })).status).toBe(401);
  });

  test("a well-formed token from another scope or a made-up secret is refused", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    const otherScope = token.replace("ftk_local_", `ftk_${ulid()}_`);
    expect((await api("GET", "/api/me", { bearer: otherScope })).status).toBe(401);
    expect((await api("GET", "/api/me", { bearer: `ftk_local_${"A".repeat(43)}` })).status).toBe(401);
  });

  test("ten tokens per user at most", async () => {
    const u = await signedInUser();
    for (let i = 0; i < 10; i++) await makeToken(u.cookie);
    expect((await api("POST", "/api/tokens", { cookie: u.cookie, body: { name: "one more" } })).status).toBe(409);
  });
});

describe("MCP endpoint", () => {
  test("initialize, then 26 tools, each annotated read-only or not", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body!.result.protocolVersion).toBe("2025-06-18");
    expect(init.body!.result.serverInfo.name).toBe("followthrough");
    expect((await rpc(token, "initialize", { protocolVersion: "1999-01-01" })).body!.result.protocolVersion).toBe("2025-06-18");
    const list = await rpc(token, "tools/list");
    const tools = list.body!.result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools).toHaveLength(26);
    expect(tools.filter((t) => t.annotations.readOnlyHint)).toHaveLength(14);
    expect(new Set(tools.map((t) => t.name)).size).toBe(26);
  });

  test("tools act as the token's user: whoami, add_client, list_clients", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    expect((await callTool(token, "whoami")).content[0]!.text).toContain(u.email);
    const made = await callTool(token, "add_client", { name: "Acme Corp" });
    expect(made.isError).toBeUndefined();
    expect((await callTool(token, "list_clients")).content[0]!.text).toContain("Acme Corp");
  });

  test("add_meeting needs consent, and a route's refusal comes back as a tool error", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    const client = JSON.parse((await callTool(token, "add_client", { name: "Globex" })).content[0]!.text) as { id?: string; client?: { id: string } };
    const clientId = client.id ?? client.client!.id;
    const refused = await callTool(token, "add_meeting", {
      client_id: clientId,
      meeting_date: "2026-11-10",
      transcript: "Client: Can we export to NetSuite?",
      consent_confirmed: false,
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("consent");
    const ok = await callTool(token, "add_meeting", {
      client_id: clientId,
      meeting_date: "2026-11-10",
      transcript: "Client: Can we export to NetSuite?",
      consent_confirmed: true,
    });
    expect(ok.isError).toBeUndefined();
  });

  test("admin-only tools refuse a member's token", async () => {
    const m = await signedInUser("member");
    const { token } = await makeToken(m.cookie);
    const r = await callTool(token, "speed_metrics");
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("403");
  });

  test("no token is 401; another site's page is refused; notifications get 202; GET is 405", async () => {
    expect((await rpc(undefined, "tools/list")).status).toBe(401);
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    expect((await rpc(token, "tools/list", undefined, { origin: "https://evil.example" })).status).toBe(403);
    const note = await api("POST", "/api/mcp", { bearer: token, body: { jsonrpc: "2.0", method: "notifications/initialized" } });
    expect(note.status).toBe(202);
    expect((await api("GET", "/api/mcp", { bearer: token })).status).toBe(405);
    expect((await rpc(token, "nope")).body!.error!.code).toBe(-32601);
    expect((await rpc(token, "tools/call", { name: "nope", arguments: {} })).body!.error!.code).toBe(-32602);
  });

  test("every tool's schema is a closed object and every required field is declared", () => {
    for (const t of TOOLS) {
      const s = t.inputSchema as { type: string; properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
      expect(s.type).toBe("object");
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required) expect(Object.keys(s.properties)).toContain(r);
    }
  });
});

describe("token hardening", () => {
  test("a token only reaches the MCP tool routes", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    expect((await api("GET", "/api/clients", { bearer: token })).status).toBe(200);
    expect((await api("POST", "/api/users", { bearer: token, body: { email: "x@tallyhall.com", name: "X" } })).status).toBe(403);
    expect((await api("GET", "/api/tokens", { bearer: token })).status).toBe(403);
    expect((await api("POST", "/api/exports/csv", { bearer: token, body: {} })).status).toBe(403);
    expect((await api("POST", "/api/settings/access", { bearer: token, body: { require_login: false } })).status).toBe(403);
  });

  test("removing a user revokes their tokens for good, even if re-enabled", async () => {
    const admin = await signedInUser();
    const member = await signedInUser("member");
    const { token } = await makeToken(member.cookie);
    expect((await api("GET", "/api/me", { bearer: token })).status).toBe(200);
    expect((await api("POST", `/api/users/${member.id}/revoke`, { cookie: admin.cookie })).status).toBe(200);
    expect((await api("GET", "/api/me", { bearer: token })).status).toBe(401);
    expect((await api("POST", `/api/users/${member.id}/rotate-code`, { cookie: admin.cookie })).status).toBe(200);
    expect((await api("GET", "/api/me", { bearer: token })).status).toBe(401);
  });

  test("ids that could steer the path are refused before any call", async () => {
    const u = await signedInUser();
    const { token } = await makeToken(u.cookie);
    for (const bad of ["../triage", "a/b", "x?y=1", "%2e%2e"]) {
      const r = await callTool(token, "get_ask", { ask_id: bad });
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain("ask_id");
    }
  });
});

describe("open-access guest", () => {
  test("cannot make a token, and a guest token is never accepted", async () => {
    delete process.env.REQUIRE_LOGIN;
    const r = await api("POST", "/api/tokens", { body: { name: "x" } });
    expect(r.status).toBe(400);
    // Even one written straight to the table does not authenticate.
    const { tokenHash } = await import("./tokens.ts");
    const t = `ftk_local_${"B".repeat(43)}`;
    await db.query("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, 'open-access-guest', 'g', ?, 'p', ?)").run(ulid(), tokenHash(t), nowIso());
    process.env.REQUIRE_LOGIN = "true";
    expect((await api("GET", "/api/me", { bearer: t })).status).toBe(401);
  });
});
