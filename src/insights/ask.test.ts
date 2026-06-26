import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { rebuildFts } from "./search.ts";
import { askMemory } from "./ask.ts";
import { MockLLM, setLLM } from "../llm/provider.ts";

afterEach(() => setLLM(null));

function seed(db: Database): { cid: string; mid: string; iid: string } {
  const cid = ulid();
  db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(cid, "Acme", nowIso());
  const mid = ulid();
  db.query(
    "INSERT INTO meetings (id, client_id, seq, meeting_date, restricted, created_at) VALUES (?, ?, 1, ?, 0, ?)",
  ).run(mid, cid, "2026-06-01", nowIso());
  const iid = ulid();
  db.query(
    "INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, state, created_at, updated_at) VALUES (?, ?, ?, 'feature_request', ?, 'raw', ?, 'extracted', ?, ?)",
  ).run(
    iid,
    mid,
    cid,
    "Auto-tagging accuracy",
    "The client wants tagging to predict the right environment values.",
    nowIso(),
    nowIso(),
  );
  db.query("INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, ?, 'uploaded', ?)").run(
    ulid(),
    mid,
    "We discussed tagging at length and the mandatory tags list.",
    nowIso(),
  );
  rebuildFts(db);
  return { cid, mid, iid };
}

describe("askMemory", () => {
  test("answers from sources and returns numbered citations", async () => {
    const db = openTestDb();
    const { iid } = seed(db);
    const mock = new MockLLM().enqueue("Tagging accuracy is the key ask [1].");
    setLLM(mock);

    const r = await askMemory(db, "what did they say about tagging?", {}, { id: ulid(), role: "admin" });

    expect(r.answer).toContain("[1]");
    expect(r.sources.length).toBeGreaterThan(0);
    expect(r.sources.some((s) => s.insight_id === iid)).toBe(true);
    expect(r.sources[0]!.n).toBe(1);
    // the model was given the source text to ground its answer
    expect(mock.calls[0]!.prompt.toLowerCase()).toContain("tagging");
  });

  test("a question with no searchable words short-circuits without calling the LLM", async () => {
    const db = openTestDb();
    seed(db);
    const mock = new MockLLM();
    setLLM(mock);

    const r = await askMemory(db, "?! ...", {}, { id: ulid(), role: "admin" });

    expect(r.sources).toHaveLength(0);
    expect(mock.calls).toHaveLength(0);
  });

  test("restricted-meeting transcript is excluded for a non-admin viewer", async () => {
    const db = openTestDb();
    const cid = ulid();
    db.query("INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)").run(cid, "X", nowIso());
    const mid = ulid();
    db.query(
      "INSERT INTO meetings (id, client_id, seq, meeting_date, restricted, allowed_users_json, created_at) VALUES (?, ?, 1, ?, 1, '[]', ?)",
    ).run(mid, cid, "2026-06-01", nowIso());
    db.query("INSERT INTO transcripts (id, meeting_id, content, source, created_at) VALUES (?, ?, ?, 'uploaded', ?)").run(
      ulid(),
      mid,
      "secret tagging discussion the member must not see",
      nowIso(),
    );
    rebuildFts(db);
    setLLM(new MockLLM().enqueue("unused"));

    const r = await askMemory(db, "tagging", {}, { id: ulid(), role: "member" });

    expect(r.sources.some((s) => s.kind === "transcript")).toBe(false);
  });
});
