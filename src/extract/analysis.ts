import type { Database } from "bun:sqlite";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent } from "../events.ts";
import { DEFAULT_MODEL, type LLM } from "../llm/provider.ts";
import { cleanTranscript } from "./segment.ts";
import {
  ANALYSIS_SYSTEM_PROMPT,
  AnalysisResponseSchema,
  analysisUserPrompt,
  renderAnalysisMarkdown,
  PROMPT_VERSION,
} from "./prompts.ts";

/**
 * Pass 4 (SPEC.md section 5, founder upgrade 2026-06-10): the meeting-level
 * brief. Atomic insights track individual asks; this is the synthesis a chief
 * of staff would hand the founder: key readings, between-the-lines subtext,
 * generalizable lessons, and action items grouped by owner team.
 */
export async function runMeetingAnalysis(
  db: Database,
  llm: LLM,
  meetingId: string,
): Promise<{ analysisId: string; markdown: string }> {
  const transcript = db
    .query("SELECT content FROM transcripts WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(meetingId) as { content: string } | null;
  if (!transcript) throw new Error("Meeting has no transcript");

  const items = db
    .query("SELECT item_type, title FROM insights WHERE meeting_id = ? AND state != 'rejected'")
    .all(meetingId) as Array<{ item_type: string; title: string }>;

  const result = await llm.completeJSON({
    system: ANALYSIS_SYSTEM_PROMPT,
    prompt: analysisUserPrompt(cleanTranscript(transcript.content), items),
    schema: AnalysisResponseSchema,
    maxTokens: 16000,
  });

  const markdown = renderAnalysisMarkdown(result.data);
  const analysisId = ulid();
  db.query(
    `INSERT INTO meeting_analyses (id, meeting_id, content_md, content_json, llm_model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(analysisId, meetingId, markdown, JSON.stringify(result.data), result.model ?? DEFAULT_MODEL, PROMPT_VERSION, nowIso());
  appendEvent(db, {
    actorUserId: null,
    entityType: "meeting",
    entityId: meetingId,
    eventType: "meeting.analysis_completed",
    payload: {
      analysis_id: analysisId,
      action_items: result.data.action_items.length,
      key_readings: result.data.key_readings.length,
    },
  });
  return { analysisId, markdown };
}

export function latestAnalysis(db: Database, meetingId: string): { content_md: string; created_at: string } | null {
  return db
    .query(
      "SELECT content_md, created_at FROM meeting_analyses WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
    )
    .get(meetingId) as { content_md: string; created_at: string } | null;
}
