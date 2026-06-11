import { describe, expect, test } from "bun:test";
import { buildQuoteMatcher, chunkTranscript, cleanTranscript } from "./segment.ts";

describe("cleanTranscript", () => {
  test("strips timestamp-only lines and normalizes whitespace", () => {
    const raw = "00:01\nAlice:   We need\tSSO.\r\n\r\n\r\n[00:02:03]\nBob: Noted.";
    expect(cleanTranscript(raw)).toBe("Alice: We need SSO.\n\nBob: Noted.");
  });

  test("strips WEBVTT-style timestamp ranges", () => {
    const raw = "00:00:01.000 --> 00:00:04.000\nHello there.\n12:34 - 13:02\nBye.";
    expect(cleanTranscript(raw)).toBe("Hello there.\nBye.");
  });

  test("keeps lines that contain a timestamp plus words", () => {
    const raw = "At 12:30 we meet.\n00:05\n";
    expect(cleanTranscript(raw)).toBe("At 12:30 we meet.");
  });

  test("is idempotent", () => {
    const raw = "00:01\nAlice:   hello   world\n\n\n\nBob: bye";
    const once = cleanTranscript(raw);
    expect(cleanTranscript(once)).toBe(once);
  });
});

describe("chunkTranscript", () => {
  test("single chunk for short text", () => {
    const chunks = chunkTranscript("hello", { chunkChars: 100, overlapChars: 10 });
    expect(chunks).toEqual([{ text: "hello", charStart: 0, charEnd: 5 }]);
  });

  test("overlapping windows cover the full text with correct offsets", () => {
    const text = "abcdefghijklmnopqrstuvwxy"; // 25 chars
    const chunks = chunkTranscript(text, { chunkChars: 10, overlapChars: 3 });
    expect(chunks.map((c) => [c.charStart, c.charEnd])).toEqual([
      [0, 10],
      [7, 17],
      [14, 24],
      [21, 25],
    ]);
    for (const c of chunks) {
      expect(c.text).toBe(text.slice(c.charStart, c.charEnd));
    }
    expect(chunks[chunks.length - 1]!.charEnd).toBe(text.length);
  });

  test("empty text yields no chunks", () => {
    expect(chunkTranscript("")).toEqual([]);
  });

  test("rejects overlap >= chunk size", () => {
    expect(() => chunkTranscript("abc", { chunkChars: 5, overlapChars: 5 })).toThrow();
  });
});

describe("buildQuoteMatcher", () => {
  const transcript = "Alice: We need  SSO\nnow.\nBob: Sure thing.";
  const find = buildQuoteMatcher(transcript);

  test("exact substring matches with offsets", () => {
    const m = find("Bob: Sure thing.");
    expect(m).not.toBeNull();
    expect(transcript.slice(m!.charStart, m!.charEnd)).toBe("Bob: Sure thing.");
  });

  test("matches across whitespace differences and returns verbatim transcript text", () => {
    const m = find("We need SSO now.");
    expect(m).not.toBeNull();
    expect(m!.verbatim).toBe("We need  SSO\nnow.");
    expect(transcript.slice(m!.charStart, m!.charEnd)).toBe(m!.verbatim);
  });

  test("rejects quotes not in the transcript", () => {
    expect(find("This was never said.")).toBeNull();
    expect(find("")).toBeNull();
  });

  test("is case-sensitive (exact match rule)", () => {
    expect(find("we need sso now.")).toBeNull();
  });
});
