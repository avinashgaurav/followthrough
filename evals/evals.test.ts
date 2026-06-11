import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockLLM, setLLM } from "../src/llm/provider.ts";
import { draftGolden } from "./draft-golden.ts";
import {
  DRAFT_NOTE,
  GoldenCaseSchema,
  extractOffline,
  scorePairs,
  slugify,
} from "./lib.ts";
import { runEvals } from "./run-evals.ts";

const TRANSCRIPT = [
  "Asha (Wovenly): We need the scheduler to skip public holidays in India.",
  "Ravi (XYZ): Understood, we will add a holiday calendar.",
  "Asha (Wovenly): Also your invoice page crashed twice last week.",
].join("\n");

const Q_HOLIDAYS = "We need the scheduler to skip public holidays in India.";
const Q_CRASH = "your invoice page crashed twice last week";
const Q_FAKE = "We demand a fifty percent discount";

function item(itemType: string, title: string, quote: string) {
  return {
    item_type: itemType,
    title,
    body: `${title}. This matters because it blocks adoption for the client.`,
    quote,
    speaker: "Asha",
    confidence: "high",
  };
}

afterEach(() => {
  setLLM(null);
});

describe("scorePairs (pure scoring math)", () => {
  const predicted = [
    { item_type: "feature_request" },
    { item_type: "complaint" },
    { item_type: "key_insight" },
  ];
  const expected = [{ item_type: "feature_request" }, { item_type: "feature_request" }];

  test("computes recall, precision, and type accuracy", () => {
    const scores = scorePairs(predicted, expected, [
      { predicted_index: 0, expected_index: 0, same_item: true },
      { predicted_index: 1, expected_index: 1, same_item: true },
      { predicted_index: 2, expected_index: null, same_item: false },
    ]);
    expect(scores.recall).toBe(1); // both expected items found
    expect(scores.precision).toBeCloseTo(2 / 3); // 2 of 3 predicted matched
    expect(scores.typeAccuracy).toBeCloseTo(1 / 2); // one of two matches has the right type
    expect(scores.missedExpected).toEqual([]);
    expect(scores.unmatchedPredicted).toEqual([2]);
  });

  test("ignores out-of-range indexes and reused expected items", () => {
    const scores = scorePairs(predicted, expected, [
      { predicted_index: 0, expected_index: 0, same_item: true },
      { predicted_index: 1, expected_index: 0, same_item: true }, // expected 0 reused: ignored
      { predicted_index: 2, expected_index: 9, same_item: true }, // out of range: ignored
      { predicted_index: -1, expected_index: 1, same_item: true }, // out of range: ignored
    ]);
    expect(scores.matched).toHaveLength(1);
    expect(scores.recall).toBeCloseTo(1 / 2);
    expect(scores.precision).toBeCloseTo(1 / 3);
    expect(scores.missedExpected).toEqual([1]);
  });

  test("same_item false never counts as a match", () => {
    const scores = scorePairs(predicted, expected, [
      { predicted_index: 0, expected_index: 0, same_item: false },
    ]);
    expect(scores.matched).toHaveLength(0);
    expect(scores.recall).toBe(0);
    expect(scores.precision).toBe(0);
    expect(scores.typeAccuracy).toBeNull();
  });

  test("empty lists score null instead of dividing by zero", () => {
    const scores = scorePairs([], [], []);
    expect(scores.recall).toBeNull();
    expect(scores.precision).toBeNull();
    expect(scores.typeAccuracy).toBeNull();
  });
});

describe("extractOffline (mirrors the app pipeline gates)", () => {
  test("applies citation gate, verifier drops, and within-run quote dedup", async () => {
    const mock = new MockLLM();
    mock.enqueue({
      items: [
        item("feature_request", "Skip public holidays", Q_HOLIDAYS),
        item("complaint", "Wants a discount", Q_FAKE), // fabricated quote: citation gate drops it
        item("complaint", "Invoice page crashed", Q_CRASH),
        item("key_insight", "Holiday duplicate", Q_HOLIDAYS), // same quote again: deduped
      ],
    });
    mock.enqueue({
      verdicts: [
        { index: 0, keep: true, reason: "real ask" },
        { index: 1, keep: false, reason: "restates the obvious" }, // drops the crash complaint
        { index: 2, keep: true, reason: "real reading" },
      ],
    });

    const result = await extractOffline(mock, TRANSCRIPT);

    expect(result.chunkCount).toBe(1);
    expect(result.extractedCount).toBe(4);
    expect(result.citationDropped).toBe(1);
    expect(result.verifierDropped).toBe(1);
    expect(result.duplicateDropped).toBe(1);
    expect(result.predicted).toHaveLength(1);
    expect(result.predicted[0]!.item_type).toBe("feature_request");
    expect(result.predicted[0]!.quote).toBe(Q_HOLIDAYS);
    expect(result.usage.calls).toBe(2);
  });

  test("skips the verifier call when verify is false", async () => {
    const mock = new MockLLM();
    mock.enqueue({ items: [item("feature_request", "Skip public holidays", Q_HOLIDAYS)] });

    const result = await extractOffline(mock, TRANSCRIPT, { verify: false });

    expect(result.predicted).toHaveLength(1);
    expect(result.verifierDropped).toBe(0);
    expect(result.usage.calls).toBe(1);
  });
});

describe("draft-golden CLI (end to end with MockLLM)", () => {
  test("writes a DRAFT case file with the expected shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-draft-"));
    const transcriptPath = join(dir, "03-wovenly-fabrics.txt");
    writeFileSync(transcriptPath, TRANSCRIPT);

    const mock = new MockLLM();
    setLLM(mock);
    mock.enqueue({
      items: [
        item("feature_request", "Skip public holidays", Q_HOLIDAYS),
        item("complaint", "Invoice page crashed", Q_CRASH),
      ],
    });
    mock.enqueue({
      verdicts: [
        { index: 0, keep: true, reason: "real ask" },
        { index: 1, keep: true, reason: "real complaint" },
      ],
    });

    const outDir = join(dir, "cases");
    const result = await draftGolden({ transcriptPath, clientName: "Wovenly", outDir });

    expect(result.slug).toBe("03-wovenly-fabrics");
    expect(result.itemCount).toBe(2);
    expect(existsSync(result.caseFile)).toBe(true);

    const written = GoldenCaseSchema.parse(JSON.parse(readFileSync(result.caseFile, "utf8")));
    expect(written.client_name).toBe("Wovenly");
    expect(written.drafted_at_note).toBe(DRAFT_NOTE);
    expect(written.transcript_file).toBe(transcriptPath); // outside the repo: stays absolute
    expect(written.expected_items).toHaveLength(2);
    expect(written.expected_items[0]).toEqual({
      item_type: "feature_request",
      title: "Skip public holidays",
      body: "Skip public holidays. This matters because it blocks adoption for the client.",
      quote: Q_HOLIDAYS,
    });
  });

  test("refuses to overwrite an existing case file without force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-draft-"));
    const transcriptPath = join(dir, "case.txt");
    writeFileSync(transcriptPath, TRANSCRIPT);
    const outDir = join(dir, "cases");

    const mock = new MockLLM();
    setLLM(mock);
    mock.enqueue({ items: [] });
    await draftGolden({ transcriptPath, outDir });

    // Founder corrections now live in the file; a re-draft must not clobber them.
    expect(draftGolden({ transcriptPath, outDir })).rejects.toThrow(/already exists/);
  });
});

describe("run-evals (end to end with a fake judge)", () => {
  test("scores a synthetic case and writes a results file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-run-"));
    const casesDir = join(dir, "cases");
    const resultsDir = join(dir, "results");
    const transcriptPath = join(dir, "wovenly.txt");
    writeFileSync(transcriptPath, TRANSCRIPT);

    const { mkdirSync } = await import("node:fs");
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(
      join(casesDir, "wovenly.json"),
      JSON.stringify({
        transcript_file: transcriptPath,
        client_name: "Wovenly",
        expected_items: [
          {
            item_type: "feature_request",
            title: "Scheduler must skip Indian public holidays",
            body: "They cannot adopt scheduling until holiday calendars are respected.",
            quote: Q_HOLIDAYS,
          },
          {
            item_type: "complaint",
            title: "Wants annual pricing",
            body: "Asked for an annual plan. The pipeline never extracted this one.",
            quote: "annual pricing",
          },
        ],
      }),
    );

    const mock = new MockLLM();
    // Call 1: extraction over the single chunk.
    mock.enqueue({
      items: [
        item("feature_request", "Skip public holidays", Q_HOLIDAYS),
        item("complaint", "Invoice page crashed", Q_CRASH),
      ],
    });
    // Call 2: verifier keeps both.
    mock.enqueue({
      verdicts: [
        { index: 0, keep: true, reason: "real ask" },
        { index: 1, keep: true, reason: "real complaint" },
      ],
    });
    // Call 3: fake judge pairs predicted 0 with expected 0; predicted 1 matches nothing.
    mock.enqueue({
      pairs: [
        { predicted_index: 0, expected_index: 0, same_item: true },
        { predicted_index: 1, expected_index: null, same_item: false },
      ],
    });

    const { results, overall, resultsFile } = await runEvals({
      casesDir,
      resultsDir,
      llm: mock,
      log: () => {},
    });

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.error).toBeUndefined();
    expect(r.still_draft).toBe(false);
    expect(r.expected_count).toBe(2);
    expect(r.predicted_count).toBe(2);
    expect(r.citation_validity).toBe(1);
    expect(r.recall).toBeCloseTo(1 / 2);
    expect(r.precision).toBeCloseTo(1 / 2);
    expect(r.type_accuracy).toBe(1);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]!.expected_title).toBe("Scheduler must skip Indian public holidays");
    expect(r.missed_expected).toEqual(["Wants annual pricing"]);
    expect(r.unmatched_predicted).toEqual(["Invoice page crashed"]);

    expect(overall.cases).toBe(1);
    expect(overall.failures).toBe(0);
    expect(overall.recall).toBeCloseTo(1 / 2);
    expect(overall.precision).toBeCloseTo(1 / 2);

    expect(resultsFile).not.toBeNull();
    const saved = JSON.parse(readFileSync(resultsFile!, "utf8"));
    expect(saved.overall.recall).toBeCloseTo(1 / 2);
    expect(saved.cases).toHaveLength(1);
    expect(saved.prompt_version).toBeString();
  });

  test("records a case error without aborting the run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evals-run-"));
    const casesDir = join(dir, "cases");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(casesDir, { recursive: true });
    writeFileSync(join(casesDir, "broken.json"), "{ not json");

    const { results, overall } = await runEvals({
      casesDir,
      resultsDir: join(dir, "results"),
      llm: new MockLLM(),
      writeResults: false,
      log: () => {},
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.error).toContain("Unreadable case file");
    expect(overall.failures).toBe(1);
  });
});

describe("slugify", () => {
  test("normalizes names to file-safe slugs", () => {
    expect(slugify("Saffron Enterprises Ltd.")).toBe("saffron-enterprises-ltd");
    expect(slugify("01-BloomNest")).toBe("01-bloomnest");
    expect(slugify("***")).toBe("case");
  });
});
