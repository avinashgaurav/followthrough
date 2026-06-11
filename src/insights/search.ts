import type { Database } from "bun:sqlite";
import { insightHandle } from "../ids.ts";

/**
 * FTS5 search (SPEC.md section 12). fts_insights carries title, polished body,
 * and every mention quote; fts_transcripts mirrors transcript content.
 * Both tables are rebuildable caches; the row tables stay the source of truth.
 */

export function rebuildFts(db: Database): { insights: number; transcripts: number } {
  const tx = db.transaction(() => {
    db.exec("DELETE FROM fts_insights;");
    db.exec(`
      INSERT INTO fts_insights (title, body, quotes, insight_id)
      SELECT i.title, i.body_current,
             COALESCE((SELECT group_concat(m.quote, ' ') FROM insight_mentions m WHERE m.insight_id = i.id), ''),
             i.id
      FROM insights i;`);
    db.exec("DELETE FROM fts_transcripts;");
    db.exec(`
      INSERT INTO fts_transcripts (content, meeting_id, content_rowid)
      SELECT t.content, t.meeting_id, t.id FROM transcripts t;`);
  });
  tx();
  const ic = db.query("SELECT COUNT(*) AS n FROM fts_insights").get() as { n: number };
  const tc = db.query("SELECT COUNT(*) AS n FROM fts_transcripts").get() as { n: number };
  return { insights: ic.n, transcripts: tc.n };
}

/** Delete-then-insert one transcript's FTS row. Call after any transcript insert. */
export function syncTranscriptFts(db: Database, transcriptId: string): void {
  const row = db
    .query("SELECT id, meeting_id, content FROM transcripts WHERE id = ?")
    .get(transcriptId) as { id: string; meeting_id: string; content: string } | null;
  if (!row) return;
  db.query("DELETE FROM fts_transcripts WHERE content_rowid = ?").run(row.id);
  db.query(
    "INSERT INTO fts_transcripts (content, meeting_id, content_rowid) VALUES (?, ?, ?)",
  ).run(row.content, row.meeting_id, row.id);
}

/** Delete-then-insert one insight's FTS row. Call after any title/body/quote change. */
export function syncInsightFts(db: Database, insightId: string): void {
  db.query("DELETE FROM fts_insights WHERE insight_id = ?").run(insightId);
  const row = db
    .query("SELECT title, body_current FROM insights WHERE id = ?")
    .get(insightId) as { title: string; body_current: string } | null;
  if (!row) return;
  const quotes = db
    .query("SELECT COALESCE(group_concat(quote, ' '), '') AS q FROM insight_mentions WHERE insight_id = ?")
    .get(insightId) as { q: string };
  db.query("INSERT INTO fts_insights (title, body, quotes, insight_id) VALUES (?, ?, ?, ?)").run(
    row.title,
    row.body_current,
    quotes.q,
    insightId,
  );
}

/**
 * Turn raw user input into a safe FTS5 query: alphanumeric tokens only, each
 * quoted, joined with implicit AND. Returns null when nothing searchable remains.
 */
export function ftsQueryFromUserInput(q: string): string | null {
  const tokens = q.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}

export interface SearchFilters {
  client_id?: string;
  track?: string;
  state?: string;
}

export interface InsightSearchHit {
  id: string;
  handle: string;
  title: string;
  state: string;
  track: string | null;
  client_id: string;
  snippet: string;
}

export interface TranscriptSearchHit {
  meeting_id: string;
  client_id: string;
  client_name: string;
  meeting_date: string;
  seq: number;
  snippet: string;
}

export function searchAll(
  db: Database,
  q: string,
  filters: SearchFilters,
): { insights: InsightSearchHit[]; transcripts: TranscriptSearchHit[] } {
  const match = ftsQueryFromUserInput(q);
  if (!match) return { insights: [], transcripts: [] };

  const conds = ["fts_insights MATCH ?"];
  const args: string[] = [match];
  if (filters.client_id) {
    conds.push("i.client_id = ?");
    args.push(filters.client_id);
  }
  if (filters.track) {
    conds.push("i.track = ?");
    args.push(filters.track);
  }
  if (filters.state) {
    conds.push("i.state = ?");
    args.push(filters.state);
  }
  const insightRows = db
    .query(
      `SELECT fts_insights.insight_id AS id, i.title, i.state, i.track, i.client_id,
              snippet(fts_insights, -1, '[', ']', '...', 12) AS snippet
       FROM fts_insights JOIN insights i ON i.id = fts_insights.insight_id
       WHERE ${conds.join(" AND ")}
       ORDER BY bm25(fts_insights) LIMIT 50`,
    )
    .all(...args) as Array<Omit<InsightSearchHit, "handle">>;

  // track/state are insight-only concepts; transcript hits are skipped when set.
  let transcripts: TranscriptSearchHit[] = [];
  if (!filters.track && !filters.state) {
    const tConds = ["fts_transcripts MATCH ?"];
    const tArgs: string[] = [match];
    if (filters.client_id) {
      tConds.push("m.client_id = ?");
      tArgs.push(filters.client_id);
    }
    transcripts = db
      .query(
        `SELECT fts_transcripts.meeting_id, m.client_id, c.name AS client_name, m.meeting_date, m.seq,
                snippet(fts_transcripts, 0, '[', ']', '...', 12) AS snippet
         FROM fts_transcripts
         JOIN meetings m ON m.id = fts_transcripts.meeting_id
         JOIN clients c ON c.id = m.client_id
         WHERE ${tConds.join(" AND ")}
         ORDER BY bm25(fts_transcripts) LIMIT 50`,
      )
      .all(...tArgs) as TranscriptSearchHit[];
  }

  return {
    insights: insightRows.map((r) => ({ ...r, handle: insightHandle(r.id) })),
    transcripts,
  };
}
