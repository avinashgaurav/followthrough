import { route, json } from "../router.ts";
import { getDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent } from "../events.ts";
import { formatHtml } from "./page.ts";

/**
 * Client-facing "You asked, we shipped" page (AUDIT.md P2-10).
 *
 * An admin generates a per-client share link; the client opens a tokenized
 * public page listing what they asked for and where it stands. Read-only,
 * no auth, token is 52 chars of ULID entropy and revocable. The page shows
 * only THAT client's insight titles and states - the same things our
 * follow-up emails already tell them.
 */

route("POST", "/api/clients/:id/share-link", "admin", (_req, user, params) => {
  const db = getDb();
  const client = db.query("SELECT id, name FROM clients WHERE id = ?").get(params.id ?? "") as
    | { id: string; name: string }
    | null;
  if (!client) return json({ error: "Client not found" }, 404);
  const token = ulid() + ulid();
  db.query("UPDATE clients SET share_token = ? WHERE id = ?").run(token, client.id);
  appendEvent(db, {
    actorUserId: user!.id,
    entityType: "client",
    entityId: client.id,
    eventType: "client.share_link_created",
    payload: {},
  });
  return json({ url: `/share/${token}` }, 201);
});

route("DELETE", "/api/clients/:id/share-link", "admin", (_req, user, params) => {
  const db = getDb();
  const res = db.query("UPDATE clients SET share_token = NULL WHERE id = ?").run(params.id ?? "");
  if (res.changes === 0) return json({ error: "Client not found" }, 404);
  appendEvent(db, {
    actorUserId: user!.id,
    entityType: "client",
    entityId: params.id!,
    eventType: "client.share_link_revoked",
    payload: {},
  });
  return json({ ok: true });
});

route("GET", "/share/:token", "public", (_req, _user, params) => {
  const db = getDb();
  const token = params.token ?? "";
  // ULID+ULID tokens are 52 chars; refuse trivially short lookups outright.
  if (token.length < 40) return new Response("Not found", { status: 404 });
  const client = db.query("SELECT id, name FROM clients WHERE share_token = ?").get(token) as
    | { id: string; name: string }
    | null;
  if (!client) return new Response("Not found", { status: 404 });

  const shipped = db
    .query(
      `SELECT i.title, i.state, i.item_type,
              COALESCE(
                (SELECT MIN(r.first_requested_at) FROM insight_requesters r
                  WHERE r.insight_id = i.id AND r.client_id = ?),
                i.created_at
              ) AS asked_at,
              (SELECT MAX(e.occurred_at) FROM events e
                WHERE e.entity_id = i.id AND e.event_type = 'insight.state_changed'
                  AND json_extract(e.payload_json, '$.to_state') = 'shipped') AS shipped_at
       FROM insights i
       WHERE i.client_id = ? AND i.state IN ('shipped','client_notified','closed')
       ORDER BY shipped_at DESC, i.created_at DESC`,
    )
    .all(client.id, client.id) as Array<{
    title: string;
    state: string;
    item_type: string;
    asked_at: string | null;
    shipped_at: string | null;
  }>;

  const inFlight = db
    .query(
      `SELECT i.title FROM insights i
       WHERE i.client_id = ? AND i.state IN ('triaged','finalized','ticketed')
       ORDER BY i.created_at DESC`,
    )
    .all(client.id) as Array<{ title: string }>;

  appendEvent(db, {
    actorUserId: null,
    entityType: "client",
    entityId: client.id,
    eventType: "client.share_page_viewed",
    payload: { at: nowIso() },
  });

  return new Response(
    formatHtml(
      client.name,
      shipped,
      inFlight.map((r) => r.title),
    ),
    {
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" },
  });
});
