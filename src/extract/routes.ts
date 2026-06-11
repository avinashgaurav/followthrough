import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { getLLM } from "../llm/provider.ts";
import { ItemTypeSchema } from "./prompts.ts";
import { ExtractionError, manualAddInsight, runExtraction } from "./pipeline.ts";
import { latestAnalysis, runMeetingAnalysis } from "./analysis.ts";

const GUARD_STATUS: Record<string, number> = {
  meeting_not_found: 404,
  meeting_deleted: 409,
  consent_missing: 409,
  no_transcript: 409,
  already_running: 409,
  already_extracted: 409,
  quote_not_found: 400,
};

function errorResponse(err: unknown): Response {
  if (err instanceof ExtractionError) {
    return json({ error: err.message, code: err.code }, GUARD_STATUS[err.code] ?? 409);
  }
  // LLM or unexpected failure; the run row already carries the error detail.
  return json({ error: err instanceof Error ? err.message : "extraction failed" }, 502);
}

route("POST", "/api/meetings/:id/extract", "user", async (req, user, params) => {
  try {
    const db = getDb();
    const force = new URL(req.url).searchParams.get("force") === "true";
    const r = await runExtraction(db, getLLM(), params.id ?? "", user!.id, { force });
    // Pass 4: the meeting-level brief. Extraction success matters more than the
    // brief, so a brief failure degrades to a warning instead of failing the run.
    let analysis: string | null = null;
    try {
      analysis = (await runMeetingAnalysis(db, getLLM(), params.id ?? "")).markdown;
    } catch (err) {
      console.warn("meeting analysis failed:", err);
    }
    return json({
      run_id: r.runId,
      created: r.created,
      mentions_added: r.mentionsAdded,
      dropped: r.droppedCitations + r.droppedVerifier,
      analysis_md: analysis,
    });
  } catch (err) {
    return errorResponse(err);
  }
});

route("GET", "/api/meetings/:id/analysis", "user", (_req, _user, params) => {
  const a = latestAnalysis(getDb(), params.id ?? "");
  if (!a) return json({ error: "no analysis yet" }, 404);
  return json({ markdown: a.content_md, created_at: a.created_at });
});

route("POST", "/api/meetings/:id/analyze", "user", async (_req, _user, params) => {
  try {
    const r = await runMeetingAnalysis(getDb(), getLLM(), params.id ?? "");
    return json({ markdown: r.markdown });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "analysis failed" }, 502);
  }
});

const ManualBodySchema = z.object({
  meeting_id: z.string().min(1),
  item_type: ItemTypeSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  quote: z.string().min(1).optional(),
  speaker: z.string().min(1).optional(),
});

route("POST", "/api/insights/manual", "user", async (req, user) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const parsed = ManualBodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "invalid body", issues: parsed.error.issues }, 400);
  }
  try {
    const r = manualAddInsight(
      getDb(),
      {
        meetingId: parsed.data.meeting_id,
        itemType: parsed.data.item_type,
        title: parsed.data.title,
        body: parsed.data.body,
        quote: parsed.data.quote,
        speaker: parsed.data.speaker,
      },
      user!.id,
    );
    return json({ insight_id: r.insightId, handle: r.handle }, 201);
  } catch (err) {
    if (err instanceof ExtractionError) return errorResponse(err);
    return json({ error: err instanceof Error ? err.message : "manual add failed" }, 500);
  }
});
