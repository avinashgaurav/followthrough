import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcribeViaDeepgram } from "./deepgram.ts";

const dir = mkdtempSync(join(tmpdir(), "ie-dg-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function audioFixture(bytes = "fake-audio-bytes"): string {
  const p = join(dir, `a-${Math.random().toString(36).slice(2)}.m4a`);
  writeFileSync(p, bytes);
  return p;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("transcribeViaDeepgram", () => {
  test("returns the paragraphs transcript when present", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: { channels: [{ alternatives: [{ transcript: "flat", paragraphs: { transcript: "para one.\n\npara two." } }] }] },
      })) as unknown as typeof fetch;
    const text = await transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k" });
    expect(text).toBe("para one.\n\npara two.");
  });

  test("sends a signed storage URL as JSON so Deepgram fetches the file itself", async () => {
    let sent: { body: unknown; type: string | null } | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = { body: JSON.parse(String(init.body)), type: new Headers(init.headers).get("content-type") };
      return jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } });
    }) as unknown as typeof fetch;
    const text = await transcribeViaDeepgram({ url: "https://store.example/signed?token=abc" }, { fetchImpl, key: "k" });
    expect(text).toBe("hello");
    expect(sent!.type).toBe("application/json");
    expect(sent!.body).toEqual({ url: "https://store.example/signed?token=abc" });
  });

  test("builds a speaker-labeled transcript from diarized utterances", async () => {
    const fetchImpl = (async () =>
      jsonResponse({
        results: {
          utterances: [
            { speaker: 0, transcript: "By when are you expecting prod?" },
            { speaker: 1, transcript: "By Wednesday." },
          ],
          channels: [{ alternatives: [{ transcript: "ignored flat" }] }],
        },
      })) as unknown as typeof fetch;
    const text = await transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k" });
    expect(text).toBe("Speaker 0: By when are you expecting prod?\nSpeaker 1: By Wednesday.");
  });

  test("falls back to the flat transcript", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "just flat" }] }] } })) as unknown as typeof fetch;
    expect(await transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k" })).toBe("just flat");
  });

  test("throws on a non-ok response", async () => {
    const fetchImpl = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    expect(transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k" })).rejects.toThrow(/401/);
  });

  test("throws on an empty transcript", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "" }] }] } })) as unknown as typeof fetch;
    expect(transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k" })).rejects.toThrow(/empty/i);
  });

  test("includes caller-supplied keyterms (e.g. user names) in the request", async () => {
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "x" }] }] } });
    }) as unknown as typeof fetch;
    await transcribeViaDeepgram(audioFixture(), { fetchImpl, key: "k", keyterms: ["Maria:2", "Sam:2"] });
    expect(url).toContain("keywords=Maria:2");
    expect(url).toContain("keywords=Sam:2");
  });

  test("throws when no key is provided", async () => {
    expect(transcribeViaDeepgram(audioFixture(), { key: "" })).rejects.toThrow(/DEEPGRAM_API_KEY/);
  });
});
