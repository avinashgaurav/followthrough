import { describe, expect, test } from "bun:test";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent } from "../events.ts";
import {
  listInsights,
  getInsightDetail,
  TriageSchema,
  triageInsight,
  updateBody,
  finalizeInsight,
  RejectSchema,
  rejectInsight,
  mergeInsight,
  setEditing,
  getQueue,
} from "./service.ts";
import { seed, makeInsight, addMention, addRequester, daysAgoIso, type InsightOpts } from "./test-helpers.ts";

describe("list", () => {
  test("filters by state, track, client_id, assignee, item_type", () => {
    const s = seed();
    const a = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      track: "engineering",
      itemType: "feature_request",
    });
    const b = makeInsight(s.db, {
      meetingId: s.meetingGlobex1,
      clientId: s.globex,
      state: "triaged",
      track: "marketing",
      assignee: s.alice.id,
      itemType: "complaint",
    });

    expect(listInsights(s.db, {}).map((r) => r.id).sort()).toEqual([a, b].sort());
    expect(listInsights(s.db, { state: "triaged" }).map((r) => r.id)).toEqual([b]);
    expect(listInsights(s.db, { track: "engineering" }).map((r) => r.id)).toEqual([a]);
    expect(listInsights(s.db, { client_id: s.globex }).map((r) => r.id)).toEqual([b]);
    expect(listInsights(s.db, { assignee: s.alice.id }).map((r) => r.id)).toEqual([b]);
    expect(listInsights(s.db, { item_type: "complaint" }).map((r) => r.id)).toEqual([b]);
    expect(listInsights(s.db, { state: "triaged", track: "engineering" })).toEqual([]);
  });

  test("age_days uses latest state_changed event, falling back to created_at", () => {
    const s = seed();
    const fresh = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      createdAt: daysAgoIso(5),
    });
    const moved = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      createdAt: daysAgoIso(9),
    });
    // backdated transition: insight entered triaged 3 days ago
    appendEvent(s.db, {
      actorUserId: s.admin.id,
      entityType: "insight",
      entityId: moved,
      eventType: "insight.state_changed",
      fromState: "extracted",
      toState: "triaged",
      occurredAt: daysAgoIso(3),
    });
    s.db.query("UPDATE insights SET state = 'triaged' WHERE id = ?").run(moved);

    const byId = new Map(listInsights(s.db, {}).map((r) => [r.id, r]));
    expect(byId.get(fresh)?.age_days).toBe(5);
    expect(byId.get(moved)?.age_days).toBe(3);
  });

  test("includes client name, counts, presence flags; orders priority desc then created_at desc", () => {
    const s = seed();
    const low = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      priority: 0,
      createdAt: daysAgoIso(2),
    });
    const high = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      priority: 5,
      createdAt: daysAgoIso(4),
    });
    const mid = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      priority: 0,
      createdAt: daysAgoIso(1),
    });
    addMention(s.db, high, s.meetingAcme1, s.acme, "we need this");
    addMention(s.db, high, s.meetingAcme2, s.acme, "asking again");
    addRequester(s.db, high, s.acme, daysAgoIso(4), daysAgoIso(1));
    s.db.query(
      "INSERT INTO tickets (id, insight_id, draft_title, draft_body_md, drafted_at) VALUES (?, ?, 't', 'b', ?)",
    ).run(ulid(), high, nowIso());
    s.db.query(
      "INSERT INTO completion_evidence (id, insight_id, kind, confidence, created_at) VALUES (?, ?, 'manual_attestation', 70, ?)",
    ).run(ulid(), high, nowIso());

    const rows = listInsights(s.db, {});
    expect(rows.map((r) => r.id)).toEqual([high, mid, low]);
    const h = rows[0]!;
    expect(h.client_name).toBe("Acme");
    expect(h.handle).toBe(`INS-${high.slice(-6)}`);
    expect(h.mention_count).toBe(2);
    expect(h.requester_count).toBe(1);
    expect(h.has_ticket).toBe(true);
    expect(h.has_evidence).toBe(true);
    expect(rows[2]!.has_ticket).toBe(false);
    expect(rows[2]!.has_evidence).toBe(false);
  });
});

describe("detail", () => {
  test("returns mentions with meeting context, requesters, tags, timeline with parsed payloads", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    addMention(s.db, id, s.meetingAcme2, s.acme, "please add SSO");
    addRequester(s.db, id, s.globex, daysAgoIso(7), daysAgoIso(2));
    triageInsight(s.db, id, s.admin, { track: "engineering", tags: ["sso"] });

    const d = getInsightDetail(s.db, id)!;
    expect(d.handle).toBe(`INS-${id.slice(-6)}`);
    expect(d.client_name).toBe("Acme");
    const mentions = d.mentions as Array<Record<string, unknown>>;
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.meeting_seq).toBe(2);
    expect(mentions[0]!.client_name).toBe("Acme");
    expect(mentions[0]!.meeting_date).toBeTruthy();
    const requesters = d.requesters as Array<Record<string, unknown>>;
    expect(requesters[0]!.client_name).toBe("Globex");
    const tags = d.tags as Array<Record<string, unknown>>;
    expect(tags.map((t) => t.name)).toEqual(["sso"]);
    const timeline = d.timeline as Array<Record<string, unknown>>;
    const stateChange = timeline.find((e) => e.event_type === "insight.state_changed")!;
    expect(stateChange.to_state).toBe("triaged");
    expect((stateChange.payload as Record<string, unknown>).track).toBe("engineering");
    expect(getInsightDetail(s.db, "MISSING")).toBeNull();
  });
});

describe("triage", () => {
  test("extracted insight transitions to triaged with tags upserted and linked", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    const res = triageInsight(s.db, id, s.admin, {
      track: "engineering",
      assignee_user_id: s.alice.id,
      tags: ["API", "latency"],
    });
    expect(res.status).toBe(200);

    const row = s.db
      .query("SELECT state, track, assignee_user_id FROM insights WHERE id = ?")
      .get(id) as { state: string; track: string; assignee_user_id: string };
    expect(row.state).toBe("triaged");
    expect(row.track).toBe("engineering");
    expect(row.assignee_user_id).toBe(s.alice.id);

    const tagNames = (
      s.db
        .query(
          "SELECT t.name, t.kind FROM insight_tags it JOIN tags t ON t.id = it.tag_id WHERE it.insight_id = ? ORDER BY t.name",
        )
        .all(id) as Array<{ name: string; kind: string }>
    );
    expect(tagNames.map((t) => t.name)).toEqual(["API", "latency"]);
    expect(tagNames.every((t) => t.kind === "freeform")).toBe(true);

    const ev = s.db
      .query(
        "SELECT to_state FROM events WHERE entity_id = ? AND event_type = 'insight.state_changed'",
      )
      .get(id) as { to_state: string };
    expect(ev.to_state).toBe("triaged");
  });

  test("re-triage appends insight.routed with previous values and dedupes tags case-insensitively", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    triageInsight(s.db, id, s.admin, { track: "engineering", assignee_user_id: s.alice.id, tags: ["API"] });
    const res = triageInsight(s.db, id, s.admin, { track: "marketing", tags: ["api"] });
    expect(res.status).toBe(200);

    const row = s.db.query("SELECT state, track, assignee_user_id FROM insights WHERE id = ?").get(id) as {
      state: string;
      track: string;
      assignee_user_id: string;
    };
    expect(row.state).toBe("triaged"); // no second transition
    expect(row.track).toBe("marketing");
    expect(row.assignee_user_id).toBe(s.alice.id); // omitted assignee preserved

    const routed = s.db
      .query("SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'insight.routed'")
      .get(id) as { payload_json: string };
    const payload = JSON.parse(routed.payload_json) as { previous: { track: string }; track: string };
    expect(payload.previous.track).toBe("engineering");
    expect(payload.track).toBe("marketing");

    const tagCount = s.db.query("SELECT COUNT(*) AS n FROM tags WHERE name = 'API'").get() as { n: number };
    expect(tagCount.n).toBe(1);
  });

  test("rejects invalid track values and unknown assignee", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    expect(TriageSchema.safeParse({ track: "sales" }).success).toBe(false);
    expect(TriageSchema.safeParse({ track: "engineering" }).success).toBe(true);
    const res = triageInsight(s.db, id, s.admin, { track: "engineering", assignee_user_id: "NOPE" });
    expect(res.status).toBe(400);
    expect(triageInsight(s.db, "MISSING", s.admin, { track: "engineering" }).status).toBe(404);
  });
});

describe("body edit", () => {
  test("bumps version, logs char counts, never touches body_original", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, body: "raw llm text" });
    const res = updateBody(s.db, id, s.alice, "polished text here", 1);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);

    const row = s.db
      .query("SELECT body_original, body_current, version FROM insights WHERE id = ?")
      .get(id) as { body_original: string; body_current: string; version: number };
    expect(row.body_original).toBe("raw llm text");
    expect(row.body_current).toBe("polished text here");
    expect(row.version).toBe(2);

    const ev = s.db
      .query("SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'insight.body_edited'")
      .get(id) as { payload_json: string };
    const payload = JSON.parse(ev.payload_json) as { chars_before: number; chars_after: number };
    expect(payload.chars_before).toBe("raw llm text".length);
    expect(payload.chars_after).toBe("polished text here".length);
  });

  test("stale version returns 409 with current_version and changes nothing", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    updateBody(s.db, id, s.alice, "first edit", 1);
    const res = updateBody(s.db, id, s.bob, "conflicting edit", 1);
    expect(res.status).toBe(409);
    expect(res.body.current_version).toBe(2);

    const row = s.db.query("SELECT body_current, version FROM insights WHERE id = ?").get(id) as {
      body_current: string;
      version: number;
    };
    expect(row.body_current).toBe("first edit");
    expect(row.version).toBe(2);
    expect(updateBody(s.db, "MISSING", s.alice, "x", 1).status).toBe(404);
  });
});

describe("finalize", () => {
  test("blocked for non-assignee member, allowed for admin, records finalized_by", () => {
    const s = seed();
    const id = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      state: "triaged",
      track: "engineering",
      assignee: s.alice.id,
    });
    const denied = finalizeInsight(s.db, id, s.bob);
    expect(denied.status).toBe(403);

    const ok = finalizeInsight(s.db, id, s.admin);
    expect(ok.status).toBe(200);
    const row = s.db.query("SELECT state, finalized_by FROM insights WHERE id = ?").get(id) as {
      state: string;
      finalized_by: string;
    };
    expect(row.state).toBe("finalized");
    expect(row.finalized_by).toBe(s.admin.id);
  });

  test("assignee may finalize; empty body and wrong state are rejected", () => {
    const s = seed();
    const id = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      state: "triaged",
      assignee: s.alice.id,
    });
    s.db.query("UPDATE insights SET body_current = '   ' WHERE id = ?").run(id);
    expect(finalizeInsight(s.db, id, s.alice).status).toBe(400);

    s.db.query("UPDATE insights SET body_current = 'ready' WHERE id = ?").run(id);
    expect(finalizeInsight(s.db, id, s.alice).status).toBe(200);

    const extracted = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    expect(finalizeInsight(s.db, extracted, s.admin).status).toBe(409); // illegal transition
    expect(finalizeInsight(s.db, "MISSING", s.admin).status).toBe(404);
  });
});

describe("reject", () => {
  test("requires a reason and records the rejected state", () => {
    const s = seed();
    expect(RejectSchema.safeParse({}).success).toBe(false);
    expect(RejectSchema.safeParse({ reason: "  " }).success).toBe(false);

    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    const res = rejectInsight(s.db, id, s.alice, "duplicate of existing ask");
    expect(res.status).toBe(200);

    const row = s.db.query("SELECT state FROM insights WHERE id = ?").get(id) as { state: string };
    expect(row.state).toBe("rejected");
    const ev = s.db
      .query(
        "SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'insight.state_changed' AND to_state = 'rejected'",
      )
      .get(id) as { payload_json: string };
    expect((JSON.parse(ev.payload_json) as { reason: string }).reason).toBe("duplicate of existing ask");
  });

  test("finalized rejection is admin-only per the transition map", () => {
    const s = seed();
    const id = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      state: "finalized",
      assignee: s.alice.id,
    });
    expect(rejectInsight(s.db, id, s.alice, "changed my mind").status).toBe(403);
    expect(rejectInsight(s.db, id, s.admin, "out of scope").status).toBe(200);
  });
});

describe("merge", () => {
  test("copies mentions and requesters, keeps widest request window, bumps priority, logs absorbed_merge", () => {
    const s = seed();
    const source = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      priority: 2,
    });
    const target = makeInsight(s.db, {
      meetingId: s.meetingGlobex1,
      clientId: s.globex,
      state: "triaged",
      priority: 1,
    });
    addMention(s.db, source, s.meetingAcme1, s.acme, "quote one");
    addMention(s.db, source, s.meetingAcme2, s.acme, "quote two");
    addMention(s.db, target, s.meetingGlobex1, s.globex, "target quote");
    // source window is wider on both ends than the target's existing acme row
    const srcFirst = daysAgoIso(20);
    const srcLast = daysAgoIso(1);
    addRequester(s.db, source, s.acme, srcFirst, srcLast);
    addRequester(s.db, source, s.globex, daysAgoIso(15), daysAgoIso(15));
    addRequester(s.db, target, s.acme, daysAgoIso(10), daysAgoIso(5));

    const res = mergeInsight(s.db, source, target, s.alice);
    expect(res.status).toBe(200);

    const src = s.db.query("SELECT state, merged_into_insight_id FROM insights WHERE id = ?").get(source) as {
      state: string;
      merged_into_insight_id: string;
    };
    expect(src.state).toBe("merged");
    expect(src.merged_into_insight_id).toBe(target);

    const mentionCount = s.db
      .query("SELECT COUNT(*) AS n FROM insight_mentions WHERE insight_id = ?")
      .get(target) as { n: number };
    expect(mentionCount.n).toBe(3);

    const reqs = s.db
      .query("SELECT client_id, first_requested_at, last_requested_at FROM insight_requesters WHERE insight_id = ?")
      .all(target) as Array<{ client_id: string; first_requested_at: string; last_requested_at: string }>;
    expect(reqs).toHaveLength(2);
    const acmeRow = reqs.find((r) => r.client_id === s.acme)!;
    expect(acmeRow.first_requested_at).toBe(srcFirst); // earliest wins
    expect(acmeRow.last_requested_at).toBe(srcLast); // latest wins
    expect(reqs.some((r) => r.client_id === s.globex)).toBe(true);

    const tgt = s.db.query("SELECT priority FROM insights WHERE id = ?").get(target) as { priority: number };
    expect(tgt.priority).toBe(1 + 2 + 1);

    const ev = s.db
      .query("SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'insight.absorbed_merge'")
      .get(target) as { payload_json: string };
    expect((JSON.parse(ev.payload_json) as { from: string }).from).toBe(source);

    const merge_ev = s.db
      .query(
        "SELECT payload_json FROM events WHERE entity_id = ? AND event_type = 'insight.state_changed' AND to_state = 'merged'",
      )
      .get(source) as { payload_json: string };
    expect((JSON.parse(merge_ev.payload_json) as { merged_into: string }).merged_into).toBe(target);
  });

  test("guards: self-merge, missing target, terminal target, source past triage", () => {
    const s = seed();
    const a = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });
    const rejected = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, state: "rejected" });
    const finalized = makeInsight(s.db, {
      meetingId: s.meetingAcme1,
      clientId: s.acme,
      state: "finalized",
      assignee: s.alice.id,
    });
    const target = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, state: "triaged" });

    expect(mergeInsight(s.db, a, a, s.alice).status).toBe(400);
    expect(mergeInsight(s.db, a, "MISSING", s.alice).status).toBe(400);
    expect(mergeInsight(s.db, "MISSING", target, s.alice).status).toBe(404);
    expect(mergeInsight(s.db, a, rejected, s.alice).status).toBe(409);
    expect(mergeInsight(s.db, finalized, target, s.admin).status).toBe(409); // no finalized -> merged edge
  });
});

describe("editing soft lock", () => {
  test("sets and clears editing_by/editing_at; another user's clear is a no-op", () => {
    const s = seed();
    const id = makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme });

    const on = setEditing(s.db, id, s.alice, true);
    expect(on.status).toBe(200);
    expect(on.body.editing_by).toBe(s.alice.id);
    expect(on.body.editing_at).toBeTruthy();

    const detail = getInsightDetail(s.db, id)!;
    expect(detail.editing_active).toBe(true);

    const bobOff = setEditing(s.db, id, s.bob, false);
    expect(bobOff.body.editing_by).toBe(s.alice.id); // not bob's lock to clear

    const off = setEditing(s.db, id, s.alice, false);
    expect(off.body.editing_by).toBeNull();
    expect(off.body.editing_at).toBeNull();
    expect(setEditing(s.db, "MISSING", s.alice, true).status).toBe(404);
  });
});

describe("my queue", () => {
  test("buckets reflect exactly what the current user must act on", () => {
    const s = seed();
    const mk = (opts: Omit<InsightOpts, "meetingId" | "clientId">) =>
      makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, ...opts });

    const reviewUnassigned = mk({ state: "extracted" });
    const reviewMine = mk({ state: "extracted", assignee: s.alice.id });
    mk({ state: "extracted", assignee: s.bob.id }); // bob's, not alice's
    const finalizeMine = mk({ state: "triaged", assignee: s.alice.id });
    mk({ state: "triaged", assignee: s.bob.id });
    const ticketMine = mk({ state: "finalized", track: "engineering", assignee: s.alice.id });
    mk({ state: "finalized", track: "marketing", assignee: s.alice.id }); // wrong track
    const ticketed = mk({ state: "finalized", track: "engineering", assignee: s.alice.id });
    s.db.query(
      "INSERT INTO tickets (id, insight_id, draft_title, draft_body_md, state, drafted_at, raised_at) VALUES (?, ?, 't', 'b', 'raised', ?, ?)",
    ).run(ulid(), ticketed, nowIso(), nowIso());

    const confirmMine = mk({ state: "ticketed", track: "engineering", assignee: s.alice.id });
    s.db.query(
      "INSERT INTO completion_evidence (id, insight_id, kind, confidence, status, created_at) VALUES (?, ?, 'release_match', 80, 'proposed', ?)",
    ).run(ulid(), confirmMine, nowIso());
    const confirmedAlready = mk({ state: "ticketed", track: "engineering", assignee: s.alice.id });
    s.db.query(
      "INSERT INTO completion_evidence (id, insight_id, kind, confidence, status, created_at) VALUES (?, ?, 'release_match', 100, 'confirmed', ?)",
    ).run(ulid(), confirmedAlready, nowIso());

    const emailMine = mk({ state: "shipped", assignee: s.alice.id });
    const emailed = mk({ state: "shipped", assignee: s.alice.id });
    const draftId = ulid();
    s.db.query(
      "INSERT INTO email_drafts (id, insight_id, client_id, subject, body_md, created_at) VALUES (?, ?, ?, 's', 'b', ?)",
    ).run(draftId, emailed, s.acme, nowIso());
    appendEvent(s.db, {
      actorUserId: s.alice.id,
      entityType: "email_draft",
      entityId: draftId,
      eventType: "email.copied",
    });

    const q = getQueue(s.db, s.alice);
    const ids = (key: string) => (q[key] as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids("to_review")).toEqual([reviewUnassigned, reviewMine].sort());
    expect(ids("to_finalize")).toEqual([finalizeMine]);
    expect(ids("to_ticket")).toEqual([ticketMine]);
    expect(ids("to_confirm")).toEqual([confirmMine]);
    expect(ids("to_email")).toEqual([emailMine]);
    expect(q.org_counts).toBeUndefined(); // members get no org-wide counts

    const bobQ = getQueue(s.db, s.bob);
    expect((bobQ.to_finalize as unknown[]).length).toBe(1);
    expect((bobQ.to_ticket as unknown[]).length).toBe(0);
  });

  test("admin additionally gets org-wide counts per state", () => {
    const s = seed();
    makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, state: "extracted" });
    makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, state: "extracted" });
    makeInsight(s.db, { meetingId: s.meetingAcme1, clientId: s.acme, state: "shipped", assignee: s.admin.id });

    const q = getQueue(s.db, s.admin);
    const counts = q.org_counts as Record<string, number>;
    expect(counts.extracted).toBe(2);
    expect(counts.shipped).toBe(1);
  });
});
