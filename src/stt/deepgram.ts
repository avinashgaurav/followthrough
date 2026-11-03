import { env } from "../config.ts";

/**
 * Speech-to-text via Deepgram's prerecorded API (DEEPGRAM_API_KEY). On the
 * hosted deployment Deepgram fetches the recording itself from a short-lived
 * signed storage URL, so large audio never passes through a function; with
 * local storage the bytes are posted directly.
 */

export class SttError extends Error {}

/** A signed URL Deepgram can fetch, raw bytes, or (tests) a local file path. */
export type AudioSource = { url: string } | { bytes: Uint8Array } | string;

// diarize + utterances give per-speaker lines so we can label who said what;
// keyterms boost accuracy on names/jargon. extraTerms (e.g. active user names,
// supplied by the caller) merge with the env list, deduped by term.
function deepgramUrl(extraTerms: string[] = []): string {
  const base =
    "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&paragraphs=true&diarize=true&utterances=true";
  const envTerms = (env.DEEPGRAM_KEYTERMS ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  // Each entry is "term" or "term:boost" (e.g. "Maria:2").
  const split = (t: string): { term: string; boost: string } => {
    const idx = t.lastIndexOf(":");
    const hasBoost = idx > 0 && /^\d+(\.\d+)?$/.test(t.slice(idx + 1).trim());
    return { term: (hasBoost ? t.slice(0, idx) : t).trim(), boost: hasBoost ? t.slice(idx + 1).trim() : "" };
  };
  const seen = new Set<string>();
  const kw = [...extraTerms, ...envTerms]
    .map(split)
    .filter(({ term }) => {
      const key = term.toLowerCase();
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    // Deepgram's boost syntax needs a literal colon (term:boost); encode only the
    // term. boost is regex-validated as numeric above, so it is URL-safe as-is.
    .map(({ term, boost }) => `&keywords=${encodeURIComponent(term)}${boost ? `:${boost}` : ""}`)
    .join("");
  return base + kw;
}

export function deepgramConfigured(): boolean {
  return !!env.DEEPGRAM_API_KEY?.trim();
}

interface Utterance {
  speaker?: number;
  transcript?: string;
}

/** Build a speaker-labeled transcript from diarized utterances; fall back to the
 *  paragraph/flat transcript when utterances are absent. */
function buildTranscript(data: {
  results?: {
    utterances?: Utterance[];
    channels?: Array<{ alternatives?: Array<{ transcript?: string; paragraphs?: { transcript?: string } }> }>;
  };
}): string {
  const utt = data.results?.utterances;
  if (Array.isArray(utt) && utt.length > 0) {
    return utt
      .map((u) => `Speaker ${u.speaker ?? "?"}: ${(u.transcript ?? "").trim()}`)
      .filter((line) => line.length > 0)
      .join("\n");
  }
  const alt = data.results?.channels?.[0]?.alternatives?.[0];
  return (alt?.paragraphs?.transcript || alt?.transcript || "").trim();
}

export async function transcribeViaDeepgram(
  source: AudioSource,
  opts: { fetchImpl?: typeof fetch; key?: string; keyterms?: string[] } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = (opts.key ?? env.DEEPGRAM_API_KEY)?.trim();
  if (!key) throw new SttError("DEEPGRAM_API_KEY is not set.");

  let body: BodyInit;
  let contentType: string;
  if (typeof source === "object" && "url" in source) {
    body = JSON.stringify({ url: source.url });
    contentType = "application/json";
  } else {
    const bytes = typeof source === "string" ? new Uint8Array(await Bun.file(source).arrayBuffer()) : source.bytes;
    if (bytes.byteLength === 0) throw new SttError("Audio file is empty.");
    body = bytes as BodyInit;
    contentType = "application/octet-stream";
  }

  let res: Response;
  try {
    res = await fetchImpl(deepgramUrl(opts.keyterms ?? []), {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": contentType },
      body,
      // Under Vercel's 300s function limit; Deepgram finishes an hour of audio well inside this.
      signal: AbortSignal.timeout(240_000),
    });
  } catch (err) {
    throw new SttError(`Deepgram request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    throw new SttError(`Deepgram error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const transcript = buildTranscript(await res.json());
  if (!transcript) throw new SttError("Deepgram returned an empty transcript.");
  return transcript;
}
