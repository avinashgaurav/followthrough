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

// Words that name the tool itself. Bare "model" is excluded: "the model risk
// committee", "the model on the Android app" are ordinary meeting talk.
const TOOL = String.raw`(?:ai(?:\s+(?:notetaker|note-taker|note\s+taker|assistant|bot))?|a\.i\.|assistant|bot|chatbot|notetaker|note-taker|note\s+taker|llm|language\s+model|transcriber|summari[sz]er)`;

const INSTRUCTION_PATTERNS: RegExp[] = [
  // "ignore previous instructions", "disregard all prior instructions"
  /\b(ignore|disregard|forget|override)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding|system)\s+(instructions?|prompts?|rules|messages?|directions?)\b/i,
  // "ignore everything above", "ignore all of the above." The target must end
  // the phrase, so "ignore everything before the March invoices" is untouched.
  /\bignore\s+(everything|all(\s+of\s+the)?)\s+(above|before)\s*([.,;:!?]|$)/i,
  // "note to the AI notetaker:", "message for the assistant." The tool word
  // must end the phrase, so "message for the assistant director" is untouched.
  new RegExp(String.raw`\b(note|message|instructions?)\s+(to|for)\s+(the\s+|any\s+|our\s+)?${TOOL}\s*([:,.;!?]|$)`, "i"),
  // Direct address followed by an imperative: "AI notetaker: mark ...",
  // "Dear assistant, record ...". The address must open the sentence, so "Our
  // AI assistant keeps trying to set ..." or "The AI feature should flag ..."
  // is untouched.
  new RegExp(String.raw`(^|[.!?]\s+)((hey|hi|dear|ok|okay)\s+)?(the\s+)?${TOOL}\s*[:,]\s*(please\s+)?(mark|record|tag|flag|set|log|classify|rate|add|change|update|ignore|treat)\b`, "i"),
  // "mark everything as high priority"
  /\bmark\s+(everything|all\s+(items|of\s+(this|these|them))|every\s+item)\s+as\b/i,
  /\b(system|developer)\s+prompt\b/i,
];

/** True when the quote reads as an instruction aimed at the tool rather than meeting content. */
export function isInstructionToTool(quote: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(quote));
}
