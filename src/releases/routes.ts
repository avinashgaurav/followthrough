import type { Database } from "bun:sqlite";
import { z } from "zod";
import { env } from "../config.ts";
import { route, json } from "../router.ts";
import { getDb, nowIso } from "../db.ts";
import { ulid, insightHandle } from "../ids.ts";
import { appendEvent, transitionInsight, TransitionError, type Role } from "../events.ts";
import { getLLM, type LLM } from "../llm/provider.ts";
import { fetchReleases, upsertReleases, type FetchLike } from "./poller.ts";
import { matchRelease } from "./matcher.ts";

/**
 * Release watcher routes (SPEC.md section 6): admin-triggered poll, release
 * and match listings, and the human confirm/reject queue. Confirmation is the
 * only path to 100 confidence and is what ships the insight.
 *
 * Server wiring (src/server.ts):
 *   import "./releases/routes.ts";            // with the other route modules
 *   import { startReleasePoller } from "./releases/routes.ts";
 *   if (import.meta.main) startReleasePoller();
 */

export class MatchActionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Actor {
  id: string;
  role: Role;
}

// ------------------------------------------------------------- poll pipeline

export interface PollCounts {
  fetched: number;
  new_releases: number;
  new_entries: number;
  matches_proposed: number;
}

/** Fetch -> upsert+parse -> match each new release. */
export async function runPollPipeline(
  db: Database,
  llm: LLM,
  fetchImpl: FetchLike = fetch,
): Promise<PollCounts> {
  const list = await fetchReleases(fetchImpl);
  const newIds = upsertReleases(db, list);
  let newEntries = 0;
  let proposed = 0;
  for (const releaseId of newIds) {
    const row = db
      .query("SELECT COUNT(*) AS n FROM release_entries WHERE release_id = ?")
      .get(releaseId) as { n: number };
    newEntries += row.n;
    const run = await matchRelease(db, llm, releaseId);
    proposed += run.proposed;
  }
  return {
    fetched: list.length,
    new_releases: newIds.length,
    new_entries: newEntries,
    matches_proposed: proposed,
  };
}

/** Hourly poll of XYZ/XYZ releases. Errors are logged, never fatal. */
export function startReleasePoller(): ReturnType<typeof setInterval> {
  const tick = () => {
    runPollPipeline(getDb(), getLLM()).catch((err) => console.warn("release poller:", err));
  };
  tick(); // catch anything published while the server was down
  const timer = setInterval(tick, 3_600_000);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

// ------------------------------------------------------------ match actions

export interface MatchRow {
  id: string;
  release_entry_id: string;
  insight_id: string;
  ticket_id: string | null;
  confidence: number;
  method: string;
  verdict: string;
  evidence_quotes_json: string | null;
  rationale: string | null;
  status: "proposed" | "confirmed" | "rejected";
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}

export function getMatch(db: Database, id: string): MatchRow | null {
  return db.query("SELECT * FROM release_matches WHERE id = ?").get(id) as MatchRow | null;
}

/**
 * Confirm a proposed match (assignee-or-admin of the insight). One
 * transaction: match -> confirmed, a confirmed completion_evidence row at
 * confidence 100, and the insight transitions to 'shipped' (from ticketed or
 * finalized; an insight already at or past shipped just gets the evidence).
 */
export function confirmMatch(db: Database, opts: { matchId: string; actor: Actor }): MatchRow {
  const row = db
    .query(
      `SELECT m.id, m.status, m.insight_id, i.state AS insight_state, i.assignee_user_id
       FROM release_matches m JOIN insights i ON i.id = m.insight_id
       WHERE m.id = ?`,
    )
    .get(opts.matchId) as {
    id: string;
    status: string;
    insight_id: string;
    insight_state: string;
    assignee_user_id: string | null;
  } | null;
  if (!row) throw new MatchActionError(404, "Match not found");
  if (opts.actor.role !== "admin" && row.assignee_user_id !== opts.actor.id) {
    throw new MatchActionError(403, "Only the insight assignee or an admin can confirm a match");
  }
  if (row.status === "confirmed") return getMatch(db, row.id)!; // idempotent
  if (row.status === "rejected") {
    throw new MatchActionError(409, "Match was rejected; re-run matching to propose a new one");
  }

  const now = nowIso();
  const evidenceId = ulid();
  const pastShipped = ["shipped", "client_notified", "closed"].includes(row.insight_state);
  const tx = db.transaction(() => {
    db.query(
      "UPDATE release_matches SET status = 'confirmed', decided_by = ?, decided_at = ? WHERE id = ?",
    ).run(opts.actor.id, now, row.id);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "match",
      entityId: row.id,
      eventType: "match.confirmed",
      payload: { insight_id: row.insight_id },
    });
    db.query(
      `INSERT INTO completion_evidence
         (id, insight_id, kind, ref_match_id, confidence, status, confirmed_by, confirmed_at, created_at)
       VALUES (?, ?, 'release_match', ?, 100, 'confirmed', ?, ?, ?)`,
    ).run(evidenceId, row.insight_id, row.id, opts.actor.id, now, now);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "evidence",
      entityId: evidenceId,
      eventType: "evidence.confirmed",
      payload: { insight_id: row.insight_id, kind: "release_match", ref_match_id: row.id },
    });
    if (!pastShipped) {
      // Valid from 'ticketed' and 'finalized'; anything else throws
      // TransitionError and rolls back the whole confirm.
      transitionInsight(db, {
        insightId: row.insight_id,
        to: "shipped",
        actor: opts.actor,
        payload: { evidence_id: evidenceId, evidence_kind: "release_match", match_id: row.id },
      });
    }
  });
  tx();
  return getMatch(db, row.id)!;
}

export function rejectMatch(
  db: Database,
  opts: { matchId: string; reason: string; actor: Actor },
): MatchRow {
  const row = db
    .query("SELECT id, status, insight_id FROM release_matches WHERE id = ?")
    .get(opts.matchId) as { id: string; status: string; insight_id: string } | null;
  if (!row) throw new MatchActionError(404, "Match not found");
  if (row.status === "confirmed") {
    throw new MatchActionError(409, "Match already confirmed; rejection would contradict the event log");
  }
  if (row.status === "rejected") return getMatch(db, row.id)!; // idempotent

  const tx = db.transaction(() => {
    db.query(
      "UPDATE release_matches SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?",
    ).run(opts.actor.id, nowIso(), row.id);
    appendEvent(db, {
      actorUserId: opts.actor.id,
      entityType: "match",
      entityId: row.id,
      eventType: "match.rejected",
      payload: { insight_id: row.insight_id, reason: opts.reason },
    });
  });
  tx();
  return getMatch(db, row.id)!;
}

// -------------------------------------------------------------------- routes

const RejectBody = z.object({ reason: z.string().min(1) });

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

function fail(err: unknown): Response {
  if (err instanceof MatchActionError) return json({ error: err.message }, err.status);
  if (err instanceof TransitionError) {
    return json({ error: err.message }, /not allowed/i.test(err.message) ? 403 : 409);
  }
  throw err;
}

route("POST", "/api/releases/poll", "admin", async () => {
  try {
    const counts = await runPollPipeline(getDb(), getLLM());
    return json(counts);
  } catch (err) {
    console.warn("release poll failed:", err);
    const message = err instanceof Error ? err.message : "release poll failed";
    // A private RELEASE_REPO 404s without auth; tell the admin what to fix.
    const hint = env.GITHUB_READ_TOKEN
      ? ""
      : ` No GITHUB_READ_TOKEN is configured — add a read-only token for ${env.RELEASE_REPO} to .env and restart.`;
    return json(
      { error: message + hint, github_token_configured: Boolean(env.GITHUB_READ_TOKEN) },
      502,
    );
  }
});

route("GET", "/api/releases", "user", () => {
  const releases = getDb()
    .query(
      `SELECT r.id, r.repo, r.tag_name, r.name, r.published_at, r.fetched_at,
              (SELECT COUNT(*) FROM release_entries e WHERE e.release_id = r.id) AS entry_count,
              (SELECT COUNT(*) FROM release_matches m
                 JOIN release_entries e ON e.id = m.release_entry_id
                WHERE e.release_id = r.id AND m.status = 'proposed') AS proposed_matches
       FROM releases r
       ORDER BY r.published_at DESC, r.rowid DESC`,
    )
    .all();
  // repo + token state let the UI explain an empty list (private repo, no
  // GITHUB_READ_TOKEN in .env) instead of silently showing nothing.
  return json({
    releases,
    repo: env.RELEASE_REPO,
    github_token_configured: Boolean(env.GITHUB_READ_TOKEN),
  });
});

route("GET", "/api/matches", "user", (req) => {
  const status = new URL(req.url).searchParams.get("status");
  if (status && !["proposed", "confirmed", "rejected"].includes(status)) {
    return json({ error: "status must be proposed, confirmed, or rejected" }, 400);
  }
  const rows = getDb()
    .query(
      `SELECT m.id, m.status, m.verdict, m.confidence, m.method, m.rationale,
              m.evidence_quotes_json, m.decided_by, m.decided_at, m.created_at,
              m.insight_id, i.title AS insight_title, i.state AS insight_state, i.track AS insight_track,
              e.id AS release_entry_id, e.title AS entry_title, e.section_type AS entry_section_type,
              e.flags_json AS entry_flags_json,
              r.id AS release_id, r.tag_name AS release_tag, r.published_at AS release_published_at
       FROM release_matches m
       JOIN insights i ON i.id = m.insight_id
       JOIN release_entries e ON e.id = m.release_entry_id
       JOIN releases r ON r.id = e.release_id
       ${status ? "WHERE m.status = ?" : ""}
       ORDER BY m.created_at DESC, m.rowid DESC`,
    )
    .all(...(status ? [status] : [])) as Array<
    Record<string, unknown> & {
      insight_id: string;
      evidence_quotes_json: string | null;
      entry_flags_json: string | null;
    }
  >;
  const matches = rows.map(({ evidence_quotes_json, entry_flags_json, ...m }) => ({
    ...m,
    insight_handle: insightHandle(m.insight_id),
    evidence_quotes: evidence_quotes_json ? (JSON.parse(evidence_quotes_json) as string[]) : [],
    entry_flags: entry_flags_json ? (JSON.parse(entry_flags_json) as string[]) : [],
  }));
  return json({ matches });
});

route("POST", "/api/matches/:id/confirm", "user", (_req, user, params) => {
  try {
    const match = confirmMatch(getDb(), {
      matchId: params.id ?? "",
      actor: { id: user!.id, role: user!.role },
    });
    return json({ match });
  } catch (err) {
    return fail(err);
  }
});

route("POST", "/api/matches/:id/reject", "user", async (req, user, params) => {
  const parsed = RejectBody.safeParse(await readBody(req));
  if (!parsed.success) return json({ error: "reason is required", issues: parsed.error.issues }, 400);
  try {
    const match = rejectMatch(getDb(), {
      matchId: params.id ?? "",
      reason: parsed.data.reason,
      actor: { id: user!.id, role: user!.role },
    });
    return json({ match });
  } catch (err) {
    return fail(err);
  }
});
