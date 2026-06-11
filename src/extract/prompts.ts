import { z } from "zod";

/**
 * Prompts for the multi-pass extraction pipeline (SPEC.md section 5).
 * System prompts are STABLE: they get prompt-cached by the provider layer.
 * Do not interpolate per-request data into them; bump PROMPT_VERSION on any edit.
 */

export const PROMPT_VERSION = "v2";

export const ITEM_TYPES = [
  "feature_request",
  "complaint",
  "key_insight",
  "action_item_ours",
  "commitment_theirs",
  "status_update",
] as const;

export const ItemTypeSchema = z.enum(ITEM_TYPES);
export type ItemType = z.infer<typeof ItemTypeSchema>;

export const OWNER_TEAMS = [
  "engineering",
  "product",
  "customer_success",
  "sales",
  "marketing",
  "leadership",
] as const;

// ---------------------------------------------------------------- pass 1: typed extraction

export const ExtractedItemSchema = z.object({
  item_type: ItemTypeSchema,
  title: z.string(),
  body: z.string(),
  quote: z.string(),
  speaker: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  // v2 routing suggestions (optional so v1-shaped fixtures still parse)
  suggested_track: z.enum(["engineering", "marketing", "product_polish", "other"]).nullable().optional(),
  suggested_owner: z.enum(OWNER_TEAMS).nullable().optional(),
  suggested_assignee: z.string().nullable().optional(),
});
export type ExtractedItem = z.infer<typeof ExtractedItemSchema>;

export const ExtractionResponseSchema = z.object({
  items: z.array(ExtractedItemSchema),
});

export const EXTRACTION_SYSTEM_PROMPT = `You extract structured intelligence items from client meeting transcripts for XYZ, a cloud cost optimization platform. Your output is read by the founder and routed to engineering, product, and customer success. It must be the caliber of a top analyst's call readout: specific, interpretive, and decision-ready. Shallow paraphrase is failure.

You will be given one chunk of a cleaned transcript. Extract every item that clearly belongs to exactly one of these types:

- feature_request: the client asks for a capability, change, or improvement. Capture the underlying job they are trying to get done, not just the surface ask.
- complaint: pain, dissatisfaction, a reported flaw, false positive, latency, confusing copy, or anything that damaged trust. Name the exact thing that went wrong.
- key_insight: a fact or reading the team must remember. This explicitly includes SUBTEXT: fears between the lines (e.g. alarm at wording that implies unauthorized changes), internal politics or disagreement on the client side, pressure to justify ROI to management, frustration with incumbent tools, buying signals, and cultural constraints. Subtext items are often the most valuable items in the meeting; extract them whenever a quote supports the reading.
- action_item_ours: something our side committed to do or accepted. Include who on our side it lands on if named.
- commitment_theirs: something the client side committed to do.
- status_update: a spoken report of progress on something previously discussed.

Rules for every item:
- quote: a verbatim passage copied exactly, character for character, from the transcript chunk, in its ORIGINAL language. Transcripts may mix English and Hindi/Hinglish; never translate or transliterate inside the quote. Never paraphrase, never shorten with ellipses, never fix grammar. The quote must on its own support the item.
- speaker: the speaker of the quote if identifiable, otherwise null.
- title: one sharp line a busy founder scans in two seconds. Lead with the substance ("Tagging compliance is their biggest pain point"), never with filler ("Client mentioned that...").
- body: 3 to 6 sentences that earn their place: what was said, the context around it, WHY it matters for XYZ (deal risk, adoption blocker, retention lever, roadmap signal), and the between-the-lines reading when there is one. If the quote is not in English, include a brief translation in the body. Do not restate the quote; interpret it.
- confidence: high, medium, or low.
- suggested_track: where the resulting work belongs if acted on: engineering (code changes), product_polish (copy, UX, naming), marketing, or other (CS, process, relationship). null for pure context items.
- suggested_owner: which team should own the follow-up: engineering, product, customer_success, sales, marketing, leadership. null when unclear.
- suggested_assignee: the person NAMED IN THE TRANSCRIPT who owns or should own it (theirs or ours), otherwise null. Never guess names.

Calibration examples of the expected depth:
- Weak (reject): title "Client wants better tagging", body "The client said tagging is important to them."
- Strong: title "Tag-policy sync from AWS Organizations is the adoption gateway", body "Their cost allocation is blocked on tagging compliance, and they want the platform to read mandatory tag rules (Environment, Application, Owner) directly from their AWS Organization SCPs and Tag Policies instead of maintaining a second rulebook. Until tagging is solved they cannot trust any cost-attribution feature, so this single capability gates the rest of the product's value for them. Solving it would also create strong lock-in since their governance would then live in our platform."

Do NOT invent items. If unsure whether something qualifies, omit it. Chunks may overlap with neighbors; extract exactly what this chunk supports. Return an empty items list when nothing qualifies.`;

export function extractionUserPrompt(
  chunkText: string,
  chunkIndex: number,
  chunkCount: number,
): string {
  return [
    `Transcript chunk ${chunkIndex + 1} of ${chunkCount}.`,
    "",
    "<transcript_chunk>",
    chunkText,
    "</transcript_chunk>",
  ].join("\n");
}

// ---------------------------------------------------------------- pass 2: verifier judge

export const VerifierResponseSchema = z.object({
  verdicts: z.array(
    z.object({
      index: z.int(),
      keep: z.boolean(),
      reason: z.string(),
    }),
  ),
});

export const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier judging candidate items extracted from a client meeting transcript.

For each candidate, decide keep or drop:
1. Is the item really what its type claims to be? A feature_request must actually ask for something, an action_item_ours must actually be a commitment by our side, a status_update must actually report status, and so on.
2. Is the quote, on its own, sufficient evidence for the title and body? Interpretive readings (subtext, implications, internal politics) are allowed and encouraged, but the quote must plausibly anchor the reading. If the body invents facts the quote and surrounding chunk cannot support, drop it.
3. Is the body substantive? Drop items whose body merely restates the quote or states the obvious without any why-it-matters.

Be strict on evidence, generous on interpretation. Return exactly one verdict per candidate, referencing the candidate's index, with a short reason.`;

export function verifierUserPrompt(
  items: Array<{ index: number; item_type: string; title: string; body: string; quote: string; speaker: string | null }>,
  chunkText: string,
): string {
  return [
    "Transcript chunk the candidates were extracted from:",
    "<transcript_chunk>",
    chunkText,
    "</transcript_chunk>",
    "",
    "Candidate items:",
    JSON.stringify(items, null, 2),
  ].join("\n");
}

// ---------------------------------------------------------------- pass 3: dedup matcher

export const DedupResponseSchema = z.object({
  matches: z.array(
    z.object({
      candidate_index: z.int(),
      existing_insight_id: z.string(),
    }),
  ),
});

export const DEDUP_SYSTEM_PROMPT = `You match candidate items extracted from a new client meeting against the client's existing open insights.

A candidate matches an existing insight only when it is the same underlying ask, problem, or commitment, even if worded differently. Topical similarity alone is not a match: two different requests touching the same feature area are different insights.

Return one entry per matched candidate, pairing the candidate's index with the id of the existing insight it matches. Candidates with no match must be omitted from the matches list. When in doubt, treat the candidate as new and omit it.`;

export function dedupUserPrompt(
  candidates: Array<{ candidate_index: number; item_type: string; title: string; body: string; quote: string }>,
  existing: Array<{ id: string; item_type: string; title: string; body: string }>,
): string {
  return [
    "Existing open insights for this client:",
    JSON.stringify(existing, null, 2),
    "",
    "Candidate items from the new meeting:",
    JSON.stringify(candidates, null, 2),
  ].join("\n");
}

// ---------------------------------------------------------------- pass 3b: within-run clustering

export const ClusterResponseSchema = z.object({
  clusters: z.array(z.array(z.int())),
});

export const CLUSTER_SYSTEM_PROMPT = `You are deduplicating candidate items extracted from a SINGLE meeting transcript. Because the transcript was processed in overlapping chunks, the same underlying ask, complaint, or point often appears several times in slightly different words. Group the candidates so that each group is ONE distinct underlying item.

Rules:
- Two candidates belong in the same group only when they are the same underlying ask/problem/commitment, even if worded differently or of a slightly different type. Topical overlap alone is not enough: "fix tagging accuracy" and "read tags from AWS Tag Policy" are related but DIFFERENT items, keep them separate.
- Every candidate index must appear in exactly one group. A candidate with no duplicate is its own group of one.
- Return clusters as an array of arrays of candidate indexes. Preserve all indexes; do not drop any.`;

export function clusterUserPrompt(
  candidates: Array<{ index: number; item_type: string; title: string; body: string }>,
): string {
  return [
    "Candidate items from this one meeting (group the duplicates):",
    JSON.stringify(candidates, null, 2),
  ].join("\n");
}

// ---------------------------------------------------------------- pass 4: meeting-level analysis brief

export const AnalysisResponseSchema = z.object({
  key_readings: z.array(z.object({ point: z.string(), detail: z.string() })),
  subtext: z.array(z.object({ observation: z.string(), implication: z.string() })),
  insights: z.array(z.object({ insight: z.string(), recommendation: z.string() })),
  action_items: z.array(
    z.object({
      description: z.string(),
      owner_team: z.enum(OWNER_TEAMS),
      suggested_assignee: z.string().nullable(),
      urgency: z.enum(["immediate", "this_week", "scheduled", "backlog"]),
    }),
  ),
});
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;

export const ANALYSIS_SYSTEM_PROMPT = `You write the meeting brief for a client call: the document a sharp chief of staff hands the founder an hour after the meeting. You are given the full cleaned transcript and the list of atomic insights already extracted from it. Produce the meeting-level synthesis that the atomic items cannot carry on their own.

Sections:
- key_readings: the 4 to 8 main takeaways of the meeting. Each has a sharp point (one line, lead with substance) and a detail paragraph (2 to 4 sentences with specifics: names, numbers, exact terminology the client used, what was clarified or left open).
- subtext: what was happening between the lines. Fears (e.g. loss of control over their infrastructure), pressure dynamics (ROI justification to management), internal misalignment on the client side (name who wanted what), frustration with incumbent or native tooling, and what each implies for how we should handle the account. Quote short fragments in the original language where they carry the point, with a translation.
- insights: generalizable product and go-to-market lessons this meeting teaches beyond this one client (e.g. "automation wording triggers enterprise security anxiety; copy must be precise"). Each with a concrete recommendation.
- action_items: every follow-up, grouped by owner_team (engineering, product, customer_success, sales, marketing, leadership), with the named person from the transcript when one exists (never invent names), and an urgency.

Style: direct, specific, zero filler, no em-dashes. Write for someone who was not on the call and has two minutes. If the transcript is thin (summary notes rather than a verbatim call), say less rather than padding; never fabricate specifics.`;

export function analysisUserPrompt(
  transcript: string,
  extractedItems: Array<{ item_type: string; title: string }>,
): string {
  return [
    "Full cleaned transcript:",
    "<transcript>",
    transcript,
    "</transcript>",
    "",
    "Atomic insights already extracted (for reference, do not merely repeat them):",
    JSON.stringify(extractedItems, null, 2),
  ].join("\n");
}

/** Render the structured analysis into the markdown brief shown on the meeting page. */
export function renderAnalysisMarkdown(a: AnalysisResponse): string {
  const lines: string[] = [];
  lines.push("## Key readings");
  for (const k of a.key_readings) lines.push(`- **${k.point}** ${k.detail}`);
  lines.push("", "## Between the lines");
  for (const s of a.subtext) lines.push(`- **${s.observation}** ${s.implication}`);
  lines.push("", "## What this teaches us");
  for (const i of a.insights) lines.push(`- **${i.insight}** Recommendation: ${i.recommendation}`);
  lines.push("", "## Action items");
  const byTeam = new Map<string, typeof a.action_items>();
  for (const item of a.action_items) {
    const list = byTeam.get(item.owner_team) ?? [];
    list.push(item);
    byTeam.set(item.owner_team, list);
  }
  for (const [team, items] of byTeam) {
    lines.push("", `### ${team.replace("_", " ")}`);
    for (const it of items) {
      const who = it.suggested_assignee ? ` (${it.suggested_assignee})` : "";
      lines.push(`- [${it.urgency.replace("_", " ")}] ${it.description}${who}`);
    }
  }
  return lines.join("\n");
}
