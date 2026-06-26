import { env } from "../config.ts";
import { SttError } from "./whisper.ts";

/**
 * Cloud speech-to-text via Deepgram's prerecorded API. Used when DEEPGRAM_API_KEY
 * is set (the deployed path, where local whisper.cpp is not installed); otherwise
 * the STT route falls back to local whisper. Audio leaves the machine to Deepgram
 * when this path is active — a deliberate trade for a hosted deployment.
 */

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
  audioPath: string,
  opts: { fetchImpl?: typeof fetch; key?: string; keyterms?: string[] } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const key = (opts.key ?? env.DEEPGRAM_API_KEY)?.trim();
  if (!key) throw new SttError("DEEPGRAM_API_KEY is not set.");

  const bytes = await Bun.file(audioPath).arrayBuffer();
  if (bytes.byteLength === 0) throw new SttError("Audio file is empty.");

  let res: Response;
  try {
    res = await fetchImpl(deepgramUrl(opts.keyterms ?? []), {
      method: "POST",
      headers: { Authorization: `Token ${key}`, "Content-Type": "application/octet-stream" },
      body: bytes,
      signal: AbortSignal.timeout(300_000), // long files take a while
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
