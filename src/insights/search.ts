import type { Database } from "../db.ts";
import { insightHandle } from "../ids.ts";

/**
 * Full-text search (SPEC.md section 12) on Postgres tsvector columns. fts_insights
 * carries title, polished body, and every mention quote; fts_transcripts mirrors
 * transcript content. Queries go through websearch_to_tsquery, which accepts the
 * quoted-token form ftsQueryFromUserInput builds and never errors on user input.
 * Both tables are rebuildable caches; the row tables stay the source of truth.
 */

export async function rebuildFts(db: Database): Promise<{ insights: number; transcripts: number }> {
  const tx = () => db.transaction(async () => {
    await db.exec("DELETE FROM fts_insights;");
    await db.exec(`
      INSERT INTO fts_insights (title, body, quotes, insight_id)
      SELECT i.title, i.body_current,
             COALESCE((SELECT string_agg(m.quote, ' ') FROM insight_mentions m WHERE m.insight_id = i.id), ''),
             i.id
      FROM insights i;`);
    await db.exec("DELETE FROM fts_transcripts;");
    await db.exec(`
      INSERT INTO fts_transcripts (content, meeting_id, content_rowid)
      SELECT t.content, t.meeting_id, t.id FROM transcripts t;`);
  });
  await tx();
  const ic = await db.query("SELECT COUNT(*) AS n FROM fts_insights").get() as { n: number };
  const tc = await db.query("SELECT COUNT(*) AS n FROM fts_transcripts").get() as { n: number };
  return { insights: ic.n, transcripts: tc.n };
}

/** Delete-then-insert one transcript's FTS row. Call after any transcript insert. */
export async function syncTranscriptFts(db: Database, transcriptId: string): Promise<void> {
  const row = await db
    .query("SELECT id, meeting_id, content FROM transcripts WHERE id = ?")
    .get(transcriptId) as { id: string; meeting_id: string; content: string } | null;
  if (!row) return;
  await db.query("DELETE FROM fts_transcripts WHERE content_rowid = ?").run(row.id);
  await db.query(
    "INSERT INTO fts_transcripts (content, meeting_id, content_rowid) VALUES (?, ?, ?)",
  ).run(row.content, row.meeting_id, row.id);
}

/** Delete-then-insert one insight's FTS row. Call after any title/body/quote change. */
export async function syncInsightFts(db: Database, insightId: string): Promise<void> {
  await db.query("DELETE FROM fts_insights WHERE insight_id = ?").run(insightId);
  const row = await db
    .query("SELECT title, body_current FROM insights WHERE id = ?")
    .get(insightId) as { title: string; body_current: string } | null;
  if (!row) return;
  const quotes = await db
    .query("SELECT COALESCE(string_agg(quote, ' '), '') AS q FROM insight_mentions WHERE insight_id = ?")
    .get(insightId) as { q: string };
  await db.query("INSERT INTO fts_insights (title, body, quotes, insight_id) VALUES (?, ?, ?, ?)").run(
    row.title,
    row.body_current,
    quotes.q,
    insightId,
  );
}

/**
 * Turn raw user input into a safe search query: alphanumeric tokens only, each
 * quoted, joined with implicit AND (websearch_to_tsquery syntax). Returns null when nothing searchable remains.
 */
export function ftsQueryFromUserInput(q: string): string | null {
  const tokens = q.split(/[^A-Za-z0-9_]+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}

/** ts_headline options matching the old FTS5 snippet(): [hit] markers, ~12 words. */
const HEADLINE = `'StartSel="[", StopSel="]", MaxWords=12, MinWords=4, MaxFragments=1, FragmentDelimiter="..."'`;

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

export async function searchAll(
  db: Database,
  q: string,
  filters: SearchFilters,
  viewer?: { id: string; role: string },
): Promise<{ insights: InsightSearchHit[]; transcripts: TranscriptSearchHit[] }> {
  const match = ftsQueryFromUserInput(q);
  if (!match) return { insights: [], transcripts: [] };

  const conds = ["fts_insights.tsv @@ q"];
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
  const insightRows = await db
    .query(
      `SELECT fts_insights.insight_id AS id, i.title, i.state, i.track, i.client_id,
              ts_headline('simple', fts_insights.title || ' ' || fts_insights.body || ' ' || fts_insights.quotes, q,
                          ${HEADLINE}) AS snippet
       FROM websearch_to_tsquery('simple', ?) AS q, fts_insights
       JOIN insights i ON i.id = fts_insights.insight_id
       WHERE ${conds.join(" AND ")}
       ORDER BY ts_rank(fts_insights.tsv, q) DESC LIMIT 50`,
    )
    .all(...args) as Array<Omit<InsightSearchHit, "handle">>;

  // track/state are insight-only concepts; transcript hits are skipped when set.
  let transcripts: TranscriptSearchHit[] = [];
  if (!filters.track && !filters.state) {
    const tConds = ["fts_transcripts.tsv @@ q"];
    const tArgs: string[] = [match];
    if (filters.client_id) {
      tConds.push("m.client_id = ?");
      tArgs.push(filters.client_id);
    }
    // Restricted meetings: same allow-list rule as media downloads, enforced
    // here too so search snippets can never leak restricted transcript text.
    if (viewer && viewer.role !== "admin") {
      // Exact membership via json_each — an instr() substring check could match a
      // user id that merely appears inside another value in the JSON.
      tConds.push(
        "(m.restricted = 0 OR m.restricted IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(m.allowed_users_json, '[]')::jsonb) AS au(value) WHERE au.value = ?))",
      );
      tArgs.push(viewer.id);
    }
    transcripts = await db
      .query(
        `SELECT fts_transcripts.meeting_id, m.client_id, c.name AS client_name, m.meeting_date, m.seq,
                ts_headline('simple', fts_transcripts.content, q, ${HEADLINE}) AS snippet
         FROM websearch_to_tsquery('simple', ?) AS q, fts_transcripts
         JOIN meetings m ON m.id = fts_transcripts.meeting_id
         JOIN clients c ON c.id = m.client_id
         WHERE ${tConds.join(" AND ")}
         ORDER BY ts_rank(fts_transcripts.tsv, q) DESC LIMIT 50`,
      )
      .all(...tArgs) as TranscriptSearchHit[];
  }

  return {
    insights: insightRows.map((r) => ({ ...r, handle: insightHandle(r.id) })),
    transcripts,
  };
}
