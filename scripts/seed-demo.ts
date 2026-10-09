// Seeds the public demo with fictional data run through the REAL pipeline:
// three client meetings for "Tallyhall" (a made-up expense platform), AI
// extraction, a changelog that ships two of the asks, and the follow-up loop
// closed for one client. Every company and person here is fictional.
//
// Usage: bun run seed:demo [--force] [--if-demo]
// Needs ANTHROPIC_API_KEY (or OPENROUTER_API_KEY). Skips a database that already
// has meetings unless --force. The seed is all-or-nothing: it builds into a
// temporary database and only swaps it in once every step has succeeded, so a
// failed LLM call never leaves a half-populated demo behind.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

// Prompts read PRODUCT_NAME when their modules load, so set it before importing.
process.env.PRODUCT_NAME ||= "Tallyhall";
process.env.PRODUCT_DESCRIPTION ||= "an expense management platform for mid-size companies";

const force = process.argv.includes("--force");
const realDir = process.env.DATA_DIR || "./data";
const realDb = join(realDir, "insights.sqlite");

function meetingCount(path: string): number {
  if (!existsSync(path)) return 0;
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM meetings").get() as { n: number }).n;
  } catch {
    return 0; // file exists but schema not created yet
  } finally {
    db.close();
  }
}

const existing = meetingCount(realDb);
if (existing > 0 && !force) {
  console.log(`Database already has ${existing} meeting(s); skipping demo seed (use --force to replace).`);
  process.exit(0);
}

// Build into a scratch DATA_DIR; config.ts reads it at import time.
const tmpDir = join(realDir, `.seed-demo-${process.pid}`);
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });
process.env.DATA_DIR = tmpDir;
process.env.BLOB_DIR ||= join(realDir, "blobs"); // content-addressed; orphans on failure are harmless

const { getDb, nowIso } = await import("../src/db.ts");
const { ulid } = await import("../src/ids.ts");
const { env, demoMode } = await import("../src/config.ts");
const { getLLM } = await import("../src/llm/provider.ts");
const { createClient, createMeeting } = await import("../src/ingest/service.ts");
const { runExtraction } = await import("../src/extract/pipeline.ts");
const { triageInsight, finalizeInsight } = await import("../src/insights/service.ts");
const { addManualRelease } = await import("../src/releases/poller.ts");
const { matchRelease } = await import("../src/releases/matcher.ts");
const { confirmMatch } = await import("../src/releases/routes.ts");
const { generateDrafts, markCopied } = await import("../src/emails/service.ts");

const dir = new URL("../demo/", import.meta.url);
const read = (name: string) => Bun.file(new URL(name, dir)).text();

function abort(message: string, code = 1): never {
  rmSync(tmpDir, { recursive: true, force: true });
  if (message) console.error(message);
  process.exit(code);
}

// Docker boot passes --if-demo so non-demo deployments never get fictional data.
if (process.argv.includes("--if-demo") && !demoMode()) abort("", 0);
if (!env.ANTHROPIC_API_KEY && !env.OPENROUTER_API_KEY) {
  abort("seed:demo needs ANTHROPIC_API_KEY or OPENROUTER_API_KEY: the demo shows real AI output.");
}

const db = getDb();
try {

  const llm = getLLM();
  const actorId = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, 'maya@tallyhall.example', 'Maya (Tallyhall)', 'admin', ?)",
  ).run(actorId, nowIso());
  const actor = { id: actorId, role: "admin" as const };

  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);

  const MEETINGS = [
    { client: "Acme Corp", domain: "acme.example", file: "acme.txt", title: "Acme: month-end close check-in", days: 21, type: "qbr" },
    { client: "Globex", domain: "globex.example", file: "globex.txt", title: "Globex: multi-entity rollout", days: 14, type: "discovery" },
    { client: "Initech", domain: "initech.example", file: "initech.txt", title: "Initech: first month review", days: 7, type: "support" },
  ] as const;

  const clientIds: Record<string, string> = {};
  for (const m of MEETINGS) {
    const { client } = createClient(db, actorId, { name: m.client, domain: m.domain });
    clientIds[m.client] = client.id as string;
    const { meeting } = await createMeeting(db, actor, {
      client_id: client.id as string,
      meeting_date: daysAgo(m.days),
      title: m.title,
      meeting_type: m.type,
      source: "manual",
      transcriptText: await read(m.file),
    });
    process.stdout.write(`Extracting ${m.title}... `);
    const result = await runExtraction(db, llm, meeting.id, actorId);
    console.log(`${result.created} insight(s), ${result.droppedCitations} dropped for bad citations`);
  }

  /** Moves the client's best-matching insight to finalized; returns its id or null. */
  function finalizeMatching(clientId: string, pattern: RegExp, track: "engineering" | "product_polish"): string | null {
    const rows = db
      .query(
        `SELECT DISTINCT i.id, i.title FROM insights i
         JOIN insight_mentions im ON im.insight_id = i.id
         WHERE im.client_id = ? AND i.state = 'extracted'`,
      )
      .all(clientId) as { id: string; title: string }[];
    const hit = rows.find((r) => pattern.test(r.title));
    if (!hit) {
      console.warn(`  no insight matched ${pattern} for this client; skipping`);
      return null;
    }
    const t = triageInsight(db, hit.id, actor, { track, assignee_user_id: actorId, tags: ["demo"] });
    if (t.status >= 300) console.warn(`  triage failed: ${JSON.stringify(t.body)}`);
    const f = finalizeInsight(db, hit.id, actor);
    if (f.status >= 300) console.warn(`  finalize failed: ${JSON.stringify(f.body)}`);
    console.log(`  finalized: ${hit.title}`);
    return hit.id;
  }

  const acmeExport = finalizeMatching(clientIds["Acme Corp"]!, /netsuite|export|cost cent/i, "engineering");
  const acmeMobile = finalizeMatching(clientIds["Acme Corp"]!, /receipt|mobile|approv/i, "product_polish");
  finalizeMatching(clientIds["Globex"]!, /entit|permission/i, "engineering");

  // Ship v2.4.0 and let the real matcher propose which asks it closes.
  const release = addManualRelease(
    db,
    { tag_name: "v2.4.0", name: "v2.4.0", body_md: await read("changelog-v2.4.md"), published_at: nowIso() },
    actorId,
  );
  const run = await matchRelease(db, llm, release.id);
  console.log(`Release v2.4.0: ${run.proposed} match(es) proposed`);

  // Close the loop for the Acme export fix: confirm it shipped, draft the email, copy it.
  if (acmeExport) {
    const match = db
      .query("SELECT id FROM release_matches WHERE insight_id = ? AND status = 'proposed' LIMIT 1")
      .get(acmeExport) as { id: string } | null;
    if (match) {
      confirmMatch(db, { matchId: match.id, actor });
      const drafts = await generateDrafts(db, { insightId: acmeExport, actor });
      if (drafts[0]) markCopied(db, { draftId: drafts[0].id, actor });
      console.log("  Acme export fix: shipped and client told");
    } else {
      console.warn("  matcher did not propose the export fix; leaving it finalized");
    }
  }
  // The mobile receipt match stays proposed so the Proof tab has something to confirm.
  if (acmeMobile) console.log("  Acme mobile receipt preview: left for you to confirm in Proof");

  // Public "you asked, we shipped" page for Acme.
  const token = ulid() + ulid();
  db.query("UPDATE clients SET share_token = ? WHERE id = ?").run(token, clientIds["Acme Corp"]!);

  // Fold the WAL into the main file, then swap the finished database into place.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(realDb + suffix, { force: true });
  renameSync(join(tmpDir, "insights.sqlite"), realDb);
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\nDemo seeded. Acme's share page: /share/${token}`);
} catch (err) {
  abort(`seed:demo failed, nothing was written to ${realDb}: ${err instanceof Error ? err.message : String(err)}`);
}
