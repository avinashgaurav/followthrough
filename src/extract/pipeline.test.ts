import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { MockLLM } from "../llm/provider.ts";
import { cleanTranscript } from "./segment.ts";
import { ExtractionError, manualAddInsight, runExtraction } from "./pipeline.ts";

const RAW_TRANSCRIPT = [
  "00:00:01",
  "Alice (Acme): We really need SSO support for our team logins.",
  "Bob (XYZ): Got it, we will scope SSO this sprint.",
  "00:01:10",
  "Alice (Acme): Also the cost dashboard takes forever to load on Mondays.",
].join("\n");

const CLEANED = cleanTranscript(RAW_TRANSCRIPT);

const Q_SSO = "We really need SSO support for our team logins.";
const Q_SCOPE = "we will scope SSO this sprint";
const Q_SLOW = "the cost dashboard takes forever to load on Mondays";

interface Seeded {
  db: Database;
  userId: string;
  clientId: string;
  meetingId: string;
  transcriptId: string | null;
}

function seed(opts: { consent?: boolean; transcript?: string | null } = {}): Seeded {
  const db = openTestDb();
  const userId = ulid();
  const clientId = ulid();
  const meetingId = ulid();
  const t = nowIso();
  db.query(
    "INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, 'Tester', 'member', ?)",
  ).run(userId, `u-${userId}@xyz.com`, t);
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, 'Acme', ?)").run(clientId, t);
  db.query(
    `INSERT INTO meetings (id, client_id, seq, meeting_date, consent_confirmed, status, uploaded_by, created_at)
     VALUES (?, ?, 1, ?, ?, 'transcribed', ?, ?)`,
  ).run(meetingId, clientId, t, opts.consent === false ? 0 : 1, userId, t);

  let transcriptId: string | null = null;
  const content = opts.transcript === undefined ? RAW_TRANSCRIPT : opts.transcript;
  if (content !== null) {
    transcriptId = ulid();
    db.query(
      "INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, ?, 'pasted', ?)",
    ).run(transcriptId, meetingId, content, t);
  }
  return { db, userId, clientId, meetingId, transcriptId };
}

function extractionResponse() {
  return {
    items: [
      {
        item_type: "feature_request",
        title: "SSO support",
        body: "Acme wants SSO for team logins. They raised it directly in the call.",
        quote: Q_SSO,
        speaker: "Alice",
        confidence: "high",
      },
      {
        item_type: "action_item_ours",
        title: "Scope SSO this sprint",
        body: "Bob committed to scoping SSO work this sprint. Owner is our side.",
        quote: Q_SCOPE,
        speaker: "Bob",
        confidence: "medium",
      },
      {
        item_type: "complaint",
        title: "Cost dashboard slow on Mondays",
        body: "The cost dashboard is slow to load on Mondays. Alice flagged it as a recurring pain.",
        quote: Q_SLOW,
        speaker: "Alice",
        confidence: "high",
      },
    ],
  };
}

function keepAll(n: number) {
  return {
    verdicts: Array.from({ length: n }, (_, index) => ({ index, keep: true, reason: "supported" })),
  };
}

/** Within-run cluster response that merges nothing: each candidate its own group. */
function noMerge(n: number) {
  return { clusters: Array.from({ length: n }, (_, i) => [i]) };
}

describe("runExtraction happy path", () => {
  test("creates insights, mentions, requesters, events, action items; finishes the run", async () => {
    const { db, userId, clientId, meetingId } = seed();
    // No open insights for the client yet, so no dedup call is made.
    // Clustering fires (3 candidates) before dedup; merge nothing.
    const mock = new MockLLM().enqueue(extractionResponse()).enqueue(keepAll(3)).enqueue(noMerge(3));

    const r = await runExtraction(db, mock, meetingId, userId);
    expect(r.created).toBe(3);
    expect(r.mentionsAdded).toBe(0);
    expect(r.droppedCitations).toBe(0);
    expect(r.droppedVerifier).toBe(0);

    const insights = db
      .query("SELECT * FROM insights ORDER BY title")
      .all() as Array<Record<string, unknown>>;
    expect(insights.length).toBe(3);
    for (const ins of insights) {
      expect(ins.state).toBe("extracted");
      expect(ins.extraction_run_id).toBe(r.runId);
      expect(ins.client_id).toBe(clientId);
      expect(ins.meeting_id).toBe(meetingId);
      expect(ins.body_original).toBe(ins.body_current);
    }

    // Mentions: verbatim transcript substrings with valid offsets.
    const mentions = db.query("SELECT * FROM insight_mentions").all() as Array<Record<string, unknown>>;
    expect(mentions.length).toBe(3);
    for (const m of mentions) {
      expect(CLEANED.slice(m.char_start as number, m.char_end as number)).toBe(m.quote as string);
    }

    // Requesters: one row per insight, first == last.
    const reqs = db.query("SELECT * FROM insight_requesters").all() as Array<Record<string, unknown>>;
    expect(reqs.length).toBe(3);
    for (const q of reqs) {
      expect(q.client_id).toBe(clientId);
      expect(q.first_requested_at).toBe(q.last_requested_at);
    }

    // Milestones view sees extracted_at via the null -> extracted event.
    const milestones = db
      .query("SELECT extracted_at FROM insight_milestones")
      .all() as Array<{ extracted_at: string | null }>;
    expect(milestones.length).toBe(3);
    for (const m of milestones) expect(m.extracted_at).toBeTruthy();

    // action_item_ours also lands in action_items, linked to its insight.
    const actions = db.query("SELECT * FROM action_items").all() as Array<Record<string, unknown>>;
    expect(actions.length).toBe(1);
    const actionInsight = insights.find((i) => i.item_type === "action_item_ours")!;
    expect(actions[0]!.insight_id).toBe(actionInsight.id);
    expect(actions[0]!.status).toBe("open");

    // Run finished, meeting advanced, completion event appended.
    const run = db.query("SELECT * FROM extraction_runs WHERE id = ?").get(r.runId) as Record<string, unknown>;
    expect(run.status).toBe("succeeded");
    expect(run.coverage_note).toBe("1 chunk, 0 citation failures, 0 verifier drops");
    expect(run.prompt_version).toBe("v2");
    expect(run.finished_at).toBeTruthy();

    const meeting = db.query("SELECT status FROM meetings WHERE id = ?").get(meetingId) as { status: string };
    expect(meeting.status).toBe("extracted");

    const completed = db
      .query("SELECT * FROM events WHERE event_type = 'extraction.completed'")
      .all() as Array<{ entity_id: string; payload_json: string }>;
    expect(completed.length).toBe(1);
    expect(completed[0]!.entity_id).toBe(r.runId);
    const payload = JSON.parse(completed[0]!.payload_json);
    expect(payload.insight_count).toBe(3);
    expect(payload.dropped_citations).toBe(0);
    expect(payload.dropped_verifier).toBe(0);

    // System prompts went out with every call (they get cached):
    // extraction + verifier + within-run clustering (no dedup, no open insights).
    expect(mock.calls.length).toBe(3);
    for (const call of mock.calls) expect(call.system).toBeTruthy();
  });
});

describe("citation gate", () => {
  test("hallucinated quote is dropped and counted; survivors proceed", async () => {
    const { db, userId, meetingId } = seed();
    const mock = new MockLLM()
      .enqueue({
        items: [
          {
            item_type: "feature_request",
            title: "SSO support",
            body: "Acme wants SSO for team logins. Raised directly in the call.",
            quote: Q_SSO,
            speaker: "Alice",
            confidence: "high",
          },
          {
            item_type: "complaint",
            title: "Invented complaint",
            body: "This item cites words that were never said in the meeting.",
            quote: "Your product deleted our production database.",
            speaker: "Alice",
            confidence: "high",
          },
        ],
      })
      .enqueue(keepAll(1)); // verifier batch only contains the surviving item

    const r = await runExtraction(db, mock, meetingId, userId);
    expect(r.created).toBe(1);
    expect(r.droppedCitations).toBe(1);
    expect(r.droppedVerifier).toBe(0);
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(1);

    const run = db.query("SELECT coverage_note FROM extraction_runs WHERE id = ?").get(r.runId) as {
      coverage_note: string;
    };
    expect(run.coverage_note).toBe("1 chunk, 1 citation failure, 0 verifier drops");
  });

  test("verifier drop is counted and the item is not created", async () => {
    const { db, userId, meetingId } = seed();
    const mock = new MockLLM()
      .enqueue({
        items: [
          {
            item_type: "feature_request",
            title: "SSO support",
            body: "Acme wants SSO for team logins. Raised directly in the call.",
            quote: Q_SSO,
            speaker: "Alice",
            confidence: "high",
          },
          {
            item_type: "commitment_theirs",
            title: "Mislabeled commitment",
            body: "Quote is our commitment, not the client's, so the type is wrong.",
            quote: Q_SCOPE,
            speaker: "Bob",
            confidence: "low",
          },
        ],
      })
      .enqueue({
        verdicts: [
          { index: 0, keep: true, reason: "clear ask" },
          { index: 1, keep: false, reason: "wrong owner: that is our commitment" },
        ],
      });

    const r = await runExtraction(db, mock, meetingId, userId);
    expect(r.created).toBe(1);
    expect(r.droppedVerifier).toBe(1);
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(1);
  });
});

describe("dedup pass", () => {
  test("a matched candidate becomes a mention on the existing insight, not a new insight", async () => {
    const { db, userId, clientId, meetingId } = seed();
    const t = nowIso();
    const existingId = ulid();
    db.query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, state, created_at, updated_at)
       VALUES (?, ?, ?, 'feature_request', 'SSO support', 'orig', 'orig', 'triaged', ?, ?)`,
    ).run(existingId, meetingId, clientId, t, t);

    const mock = new MockLLM()
      .enqueue({
        items: [
          {
            item_type: "feature_request",
            title: "SSO again",
            body: "Acme repeated the SSO ask. Same underlying request as before.",
            quote: Q_SSO,
            speaker: "Alice",
            confidence: "high",
          },
        ],
      })
      .enqueue(keepAll(1))
      .enqueue({ matches: [{ candidate_index: 0, existing_insight_id: existingId }] });

    const r = await runExtraction(db, mock, meetingId, userId);
    expect(r.created).toBe(0);
    expect(r.mentionsAdded).toBe(1);

    // No new insight; mention attached to the existing one; priority bumped.
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(1);
    const mention = db.query("SELECT * FROM insight_mentions").get() as Record<string, unknown>;
    expect(mention.insight_id).toBe(existingId);
    expect(mention.quote).toBe(Q_SSO);
    const ins = db.query("SELECT priority FROM insights WHERE id = ?").get(existingId) as { priority: number };
    expect(ins.priority).toBe(1);

    // Requester row upserted, mention event appended.
    const req = db
      .query("SELECT * FROM insight_requesters WHERE insight_id = ? AND client_id = ?")
      .get(existingId, clientId);
    expect(req).toBeTruthy();
    const ev = db
      .query("SELECT * FROM events WHERE event_type = 'insight.mention_added' AND entity_id = ?")
      .get(existingId);
    expect(ev).toBeTruthy();
  });

  test("hallucinated existing_insight_id from the dedup judge is ignored", async () => {
    const { db, userId, clientId, meetingId } = seed();
    const t = nowIso();
    const existingId = ulid();
    db.query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, created_at, updated_at)
       VALUES (?, ?, ?, 'complaint', 'Other thing', 'orig', 'orig', ?, ?)`,
    ).run(existingId, meetingId, clientId, t, t);

    const mock = new MockLLM()
      .enqueue({
        items: [
          {
            item_type: "feature_request",
            title: "SSO support",
            body: "Acme wants SSO for team logins. Raised directly in the call.",
            quote: Q_SSO,
            speaker: "Alice",
            confidence: "high",
          },
        ],
      })
      .enqueue(keepAll(1))
      .enqueue({ matches: [{ candidate_index: 0, existing_insight_id: "NOT-A-REAL-ID" }] });

    const r = await runExtraction(db, mock, meetingId, userId);
    // Bogus id is not in the open set, so the candidate is treated as new.
    expect(r.created).toBe(1);
    expect(r.mentionsAdded).toBe(0);
  });
});

describe("re-run idempotency", () => {
  test("re-running with identical outputs creates nothing new and resurrects nothing", async () => {
    const { db, userId, meetingId } = seed();
    const run1 = await runExtraction(
      db,
      new MockLLM().enqueue(extractionResponse()).enqueue(keepAll(3)).enqueue(noMerge(3)),
      meetingId,
      userId,
    );
    expect(run1.created).toBe(3);

    // Reject one insight: a re-run must not resurrect it either.
    const rejectedId = (db.query("SELECT id FROM insights LIMIT 1").get() as { id: string }).id;
    db.query("UPDATE insights SET state = 'rejected' WHERE id = ?").run(rejectedId);

    // Same mock outputs again (force past the already-extracted guard). All
    // quotes already exist as mentions for this client, so every candidate is
    // filtered before clustering and dedup (no further LLM calls).
    const run2 = await runExtraction(
      db,
      new MockLLM().enqueue(extractionResponse()).enqueue(keepAll(3)),
      meetingId,
      userId,
      { force: true },
    );
    expect(run2.created).toBe(0);
    expect(run2.mentionsAdded).toBe(0);

    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(3);
    expect((db.query("SELECT COUNT(*) AS n FROM insight_mentions").get() as { n: number }).n).toBe(3);
    expect(
      (db.query("SELECT state FROM insights WHERE id = ?").get(rejectedId) as { state: string }).state,
    ).toBe("rejected");
    expect(
      (db.query("SELECT COUNT(*) AS n FROM extraction_runs WHERE status = 'succeeded'").get() as { n: number }).n,
    ).toBe(2);
  });
});

describe("within-run clustering", () => {
  test("merges near-duplicate candidates into one insight; siblings become mentions", async () => {
    const { db, userId, meetingId } = seed();
    // All 3 candidates extracted; cluster collapses items 0 and 1 (the two SSO
    // restatements) into one insight, leaving the slow-dashboard complaint alone.
    const mock = new MockLLM()
      .enqueue(extractionResponse())
      .enqueue(keepAll(3))
      .enqueue({ clusters: [[0, 1], [2]] });

    const r = await runExtraction(db, mock, meetingId, userId);
    expect(r.created).toBe(2); // 2 distinct insights, not 3
    // The merged insight carries both quotes as mentions; total mentions = 3.
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(2);
    expect((db.query("SELECT COUNT(*) AS n FROM insight_mentions").get() as { n: number }).n).toBe(3);
  });

  test("re-extraction is blocked unless forced", async () => {
    const { db, userId, meetingId } = seed();
    await runExtraction(
      db,
      new MockLLM().enqueue(extractionResponse()).enqueue(keepAll(3)).enqueue(noMerge(3)),
      meetingId,
      userId,
    );
    // A second call without force hits the guard.
    await expect(
      runExtraction(db, new MockLLM(), meetingId, userId),
    ).rejects.toThrow(/already/i);
  });
});

describe("failure and guards", () => {
  test("LLM failure marks the run failed, appends extraction.failed, rethrows", async () => {
    const { db, userId, meetingId } = seed();
    const mock = new MockLLM(); // empty queue: first completeJSON call throws

    await expect(runExtraction(db, mock, meetingId, userId)).rejects.toThrow("MockLLM queue empty");

    const run = db.query("SELECT * FROM extraction_runs").get() as Record<string, unknown>;
    expect(run.status).toBe("failed");
    expect(run.error).toContain("MockLLM queue empty");
    expect(run.finished_at).toBeTruthy();

    const ev = db
      .query("SELECT * FROM events WHERE event_type = 'extraction.failed' AND entity_id = ?")
      .get(run.id as string);
    expect(ev).toBeTruthy();

    // Nothing half-written; meeting status untouched.
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(0);
    const meeting = db.query("SELECT status FROM meetings WHERE id = ?").get(meetingId) as { status: string };
    expect(meeting.status).toBe("transcribed");
  });

  test("guards: missing meeting, missing consent, missing transcript", async () => {
    const mockFor = () => new MockLLM();

    const a = seed();
    await expect(runExtraction(a.db, mockFor(), "NOPE", a.userId)).rejects.toThrow(ExtractionError);

    const b = seed({ consent: false });
    await expect(runExtraction(b.db, mockFor(), b.meetingId, b.userId)).rejects.toThrow(/[Cc]onsent/);

    const c = seed({ transcript: null });
    await expect(runExtraction(c.db, mockFor(), c.meetingId, c.userId)).rejects.toThrow(/transcript/);

    // Guard failures happen before any run row is written.
    for (const s of [a, b, c]) {
      expect((s.db.query("SELECT COUNT(*) AS n FROM extraction_runs").get() as { n: number }).n).toBe(0);
    }
  });
});

describe("manualAddInsight", () => {
  test("with a verified quote: insight + mention with offsets + requester + event, run id NULL", () => {
    const { db, userId, clientId, meetingId } = seed();
    const r = manualAddInsight(
      db,
      {
        meetingId,
        itemType: "feature_request",
        title: "SSO support",
        body: "Added by a human reviewer who caught what the LLM missed.",
        quote: Q_SSO,
        speaker: "Alice",
      },
      userId,
    );
    expect(r.handle).toBe(`INS-${r.insightId.slice(-6)}`);

    const ins = db.query("SELECT * FROM insights WHERE id = ?").get(r.insightId) as Record<string, unknown>;
    expect(ins.extraction_run_id).toBeNull();
    expect(ins.ai_confidence).toBeNull();
    expect(ins.state).toBe("extracted");

    const mention = db.query("SELECT * FROM insight_mentions WHERE insight_id = ?").get(r.insightId) as Record<
      string,
      unknown
    >;
    expect(mention.quote).toBe(Q_SSO);
    expect(CLEANED.slice(mention.char_start as number, mention.char_end as number)).toBe(Q_SSO);

    const req = db
      .query("SELECT * FROM insight_requesters WHERE insight_id = ? AND client_id = ?")
      .get(r.insightId, clientId);
    expect(req).toBeTruthy();

    const milestone = db
      .query("SELECT extracted_at FROM insight_milestones WHERE insight_id = ?")
      .get(r.insightId) as { extracted_at: string | null };
    expect(milestone.extracted_at).toBeTruthy();
  });

  test("without a quote: insight accepted with no mention row", () => {
    const { db, userId, meetingId } = seed();
    const r = manualAddInsight(
      db,
      {
        meetingId,
        itemType: "key_insight",
        title: "Acme is consolidating cloud vendors",
        body: "Came up off-transcript in the hallway conversation after the call.",
      },
      userId,
    );
    expect((db.query("SELECT COUNT(*) AS n FROM insight_mentions").get() as { n: number }).n).toBe(0);
    const ins = db.query("SELECT state FROM insights WHERE id = ?").get(r.insightId) as { state: string };
    expect(ins.state).toBe("extracted");
  });

  test("manual action_item_ours also creates an action_items row", () => {
    const { db, userId, meetingId } = seed();
    const r = manualAddInsight(
      db,
      {
        meetingId,
        itemType: "action_item_ours",
        title: "Send pricing sheet",
        body: "We owe Acme the updated pricing sheet by Friday.",
        quote: Q_SCOPE,
      },
      userId,
    );
    const action = db.query("SELECT * FROM action_items WHERE insight_id = ?").get(r.insightId);
    expect(action).toBeTruthy();
  });

  test("rejects a quote that is not in the transcript", () => {
    const { db, userId, meetingId } = seed();
    expect(() =>
      manualAddInsight(
        db,
        {
          meetingId,
          itemType: "complaint",
          title: "Bad quote",
          body: "Quote does not exist in the transcript so this must fail.",
          quote: "Words nobody ever said.",
        },
        userId,
      ),
    ).toThrow(/not a substring/);
    expect((db.query("SELECT COUNT(*) AS n FROM insights").get() as { n: number }).n).toBe(0);
  });

  test("rejects a quote when the meeting has no transcript", () => {
    const { db, userId, meetingId } = seed({ transcript: null });
    expect(() =>
      manualAddInsight(
        db,
        {
          meetingId,
          itemType: "complaint",
          title: "No transcript",
          body: "Quote cannot be verified because there is no transcript.",
          quote: "anything",
        },
        userId,
      ),
    ).toThrow(/no transcript/);
  });
});
