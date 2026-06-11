/**
 * Pure transcript segmentation utilities (SPEC.md section 5, step 1).
 * No DB, no LLM: clean, chunk with overlap, and verify quotes with offsets.
 */

// Matches lines that contain only a timestamp or a timestamp range, e.g.
// "00:12", "[00:01:02]", "00:00:01.000 --> 00:00:04.000", "12:34 - 13:02".
const TS = String.raw`[\[(]?\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?[\])]?`;
const TIMESTAMP_ONLY_LINE = new RegExp(`^\\s*${TS}(?:\\s*(?:-+>?|to)\\s*${TS})?\\s*$`, "i");

/** Normalize whitespace and strip timestamp-only lines. Idempotent. */
export function cleanTranscript(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (TIMESTAMP_ONLY_LINE.test(line) && line.trim() !== "") continue;
    kept.push(line.replace(/[ \t\f\v]+/g, " ").trim());
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface Chunk {
  text: string;
  charStart: number; // inclusive offset into the cleaned transcript
  charEnd: number; // exclusive
}

/** Overlapping character windows so items spanning a boundary appear whole in one chunk. */
export function chunkTranscript(
  text: string,
  opts: { chunkChars?: number; overlapChars?: number } = {},
): Chunk[] {
  const chunkChars = opts.chunkChars ?? 12000;
  const overlapChars = opts.overlapChars ?? 1000;
  if (chunkChars <= 0) throw new Error("chunkChars must be positive");
  if (overlapChars < 0 || overlapChars >= chunkChars) {
    throw new Error("overlapChars must be >= 0 and < chunkChars");
  }
  if (text.length === 0) return [];

  const chunks: Chunk[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + chunkChars, text.length);
    chunks.push({ text: text.slice(start, end), charStart: start, charEnd: end });
    if (end >= text.length) break;
    start = end - overlapChars;
  }
  return chunks;
}

export interface QuoteMatch {
  charStart: number; // offset into the original (cleaned) transcript
  charEnd: number; // exclusive
  verbatim: string; // exact transcript substring covering the quote
}

/**
 * Citation gate matcher: exact match after whitespace normalization
 * (runs of whitespace compare equal to a single space; case-sensitive).
 * Builds a normalized shadow string with an index map back to original
 * offsets so char_start/char_end always point into the real transcript.
 */
export function buildQuoteMatcher(transcript: string): (quote: string) => QuoteMatch | null {
  const map: number[] = []; // normalized index -> original index
  let norm = "";
  let wsPending = false;
  for (let i = 0; i < transcript.length; i++) {
    const ch = transcript[i]!;
    if (/\s/.test(ch)) {
      if (norm.length > 0) wsPending = true; // leading whitespace is dropped
      continue;
    }
    if (wsPending) {
      norm += " ";
      map.push(i); // a separator maps to the char after it; never a match boundary
      wsPending = false;
    }
    norm += ch;
    map.push(i);
  }

  return (quote: string): QuoteMatch | null => {
    const normQuote = quote.replace(/\s+/g, " ").trim();
    if (normQuote.length === 0) return null;
    const idx = norm.indexOf(normQuote);
    if (idx === -1) return null;
    const charStart = map[idx]!;
    const charEnd = map[idx + normQuote.length - 1]! + 1;
    return { charStart, charEnd, verbatim: transcript.slice(charStart, charEnd) };
  };
}
