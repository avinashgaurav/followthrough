import { z } from "zod";
import { getDb, nowIso } from "./db.ts";
import { ulid } from "./ids.ts";
import { route, json } from "./router.ts";
import { bearerToken, currentScope, MAX_TOKENS_PER_USER, newToken, tokenHash } from "./tokens.ts";

// ---------------------------------------------------------------- routes

const CreateSchema = z.object({ name: z.string().trim().min(1).max(60) });

/** Tokens are made and revoked from a signed-in browser only, never with another token. */
function fromBrowserOnly(req: Request): Response | null {
  return bearerToken(req) ? json({ error: "Make and revoke tokens from the app, signed in." }, 403) : null;
}

route("GET", "/api/tokens", "user", async (_req, user) => {
  const tokens = await getDb()
    .query(
      `SELECT id, name, prefix, created_at, last_used_at FROM api_tokens
       WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`,
    )
    .all(user!.id);
  return json({ tokens, max: MAX_TOKENS_PER_USER });
});

route("POST", "/api/tokens", "user", async (req, user) => {
  const refused = fromBrowserOnly(req);
  if (refused) return refused;
  const body = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "Name the token (up to 60 characters), for example \"Claude on my laptop\"." }, 400);
  const scope = currentScope();
  if (!scope) return json({ error: "No workspace." }, 400);
  const db = getDb();
  const id = ulid();
  const token = newToken(scope);
  const created = await db.transaction(async () => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext(?))").run(`followthrough:tokens:${scope}:${user!.id}`);
    const { n } = (await db
      .query("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL")
      .get(user!.id)) as { n: number };
    if (n >= MAX_TOKENS_PER_USER) return false;
    await db
      .query("INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, user!.id, body.data.name, tokenHash(token), token.slice(0, token.length - 39), nowIso());
    return true;
  });
  if (!created) return json({ error: `You already have ${MAX_TOKENS_PER_USER} tokens. Revoke one first.` }, 409);
  return json({ id, name: body.data.name, token }, 201, { "cache-control": "no-store" });
});

route("POST", "/api/tokens/:id/revoke", "user", async (req, user, params) => {
  const refused = fromBrowserOnly(req);
  if (refused) return refused;
  const r = await getDb()
    .query("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL RETURNING id")
    .run(nowIso(), params.id ?? "", user!.id);
  return r.rows.length ? json({ ok: true }) : json({ error: "That token is already revoked or isn't yours." }, 404);
});
