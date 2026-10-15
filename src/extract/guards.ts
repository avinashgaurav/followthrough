/**
 * Deterministic guard against prompt injection in transcripts.
 *
 * The extraction prompt already says transcript text is data. This is the
 * code-side belt: an item whose cited quote is itself an instruction aimed at
 * an AI, a notetaker or this system is dropped before it can become an
 * insight, whatever the model decided. The patterns are deliberately narrow
 * (they need an AI-directed address or a classic override phrase), so a client
 * saying "please ignore the old invoices" or "this is high priority for us"
 * is untouched.
 */

const INSTRUCTION_PATTERNS: RegExp[] = [
  // "ignore previous instructions", "disregard all prior instructions"
  /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions?|prompts?|rules|messages?|directions?)\b/i,
  // "note to the AI notetaker", "message for the assistant"
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+|our\s+)?(ai|a\.i\.|assistant|bot|chatbot|notetaker|note-taker|note\s+taker|llm|language\s+model|model|transcriber|summari[sz]er)\b/i,
  // "AI notetaker: mark ...", "dear assistant, record ..."
  /\b(ai|assistant|notetaker|note-taker|llm|bot)\b[^.!?\n]{0,40}\b(mark|record|tag|flag|set|log|classify|rate)\b/i,
  // "mark everything as high priority"
  /\bmark\s+(everything|all\s+(items|of\s+(this|these|them))|every\s+item)\s+as\b/i,
  /\b(system|developer)\s+prompt\b/i,
];

/** True when the quote reads as an instruction aimed at the tool rather than meeting content. */
export function isInstructionToTool(quote: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(quote));
}
