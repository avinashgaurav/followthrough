import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { z } from "zod";
import { json } from "../router.ts";
import { nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import { appendEvent } from "../events.ts";
import type { AuthedUser } from "../auth.ts";
import { cleanTranscript } from "../extract/segment.ts";
import { syncTranscriptFts } from "../insights/search.ts";
import {
  IngestError,
  MAX_TRANSCRIPT_BYTES,
  assertSizeOk,
  getBlobPath,
  saveBlob,
  sha256Hex,
  type MediaAsset,
} from "./media.ts";

/**
 * Ingest module: clients, contacts, meetings, uploads, transcripts (SPEC.md
 * sections 2, 3, 9, 10). Business functions take db first so tests inject
 * openTestDb(); the handle* functions are the HTTP layer and are also
 * db-injected so routes.ts stays a pure registration file.
 */

const MEETING_TYPES = ["discovery", "demo", "qbr", "support", "other"] as const;
const MEETING_SOURCES = ["extension", "meet", "zoom", "fireflies", "manual", "watch_folder", "drive"] as const;

// states that no longer count as open work for a client
const TERMINAL_STATES = "('closed','rejected','merged')";

// ---------------------------------------------------------------- schemas

const ContactSchema = z.object({
  name: z.string().min(1),
  email: z.email().optional(),
  title: z.string().min(1).optional(),
});

const ClientCreateSchema = z.object({
  name: z.string().min(1),
  domain: z.string().min(1).optional(),
  is_internal: z.boolean().optional(),
  contacts: z.array(ContactSchema).optional(),
});

const MeetingFieldsSchema = z.object({
  client_id: z.string().min(1),
  meeting_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, "meeting_date must start with YYYY-MM-DD"),
  title: z.string().min(1).optional(),
  meeting_type: z.enum(MEETING_TYPES).optional(),
  source: z.enum(MEETING_SOURCES).optional(),
  attendees_json: z.string().min(1).optional(),
});

const TranscriptPasteSchema = z.object({
  text: z.string().min(1),
});

// ---------------------------------------------------------------- row types

export interface MeetingRow {
  id: string;
  client_id: string;
  seq: number;
  title: string | null;
  meeting_date: string;
  meeting_type: string | null;
  source: string;
  attendees_json: string | null;
  audio_asset_id: string | null;
  consent_confirmed: number;
  restricted: number;
  allowed_users_json: string | null;
  status: string;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
}

export interface UploadedFile {
  filename: string;
  contentType: string | null;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------- clients

export function createClient(
  db: Database,
  actorId: string,
  input: z.infer<typeof ClientCreateSchema>,
): { client: Record<string, unknown>; contacts: Record<string, unknown>[] } {
  const id = ulid();
  const t = nowIso();
  const tx = db.transaction(() => {
    db.query(
      "INSERT INTO clients (id, name, domain, is_internal, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, input.name, input.domain ?? null, input.is_internal ? 1 : 0, actorId, t);
    for (const c of input.contacts ?? []) {
      db.query(
        "INSERT INTO client_contacts (id, client_id, name, email, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(ulid(), id, c.name, c.email ?? null, c.title ?? null, t);
    }
  });
  tx();
  return {
    client: db.query("SELECT * FROM clients WHERE id = ?").get(id) as Record<string, unknown>,
    contacts: db
      .query("SELECT * FROM client_contacts WHERE client_id = ? ORDER BY created_at")
      .all(id) as Record<string, unknown>[],
  };
}

export function listClients(db: Database): Record<string, unknown>[] {
  return db
    .query(
      `SELECT c.*,
         (SELECT COUNT(*) FROM meetings m WHERE m.client_id = c.id AND m.deleted_at IS NULL) AS meetings_count,
         (SELECT COUNT(*) FROM insights i WHERE i.client_id = c.id AND i.state NOT IN ${TERMINAL_STATES}) AS open_insights_count
       FROM clients c
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as Record<string, unknown>[];
}

export function getClientDetail(db: Database, clientId: string): Record<string, unknown> | null {
  const client = db.query("SELECT * FROM clients WHERE id = ?").get(clientId);
  if (!client) return null;
  const contacts = db
    .query("SELECT * FROM client_contacts WHERE client_id = ? ORDER BY created_at")
    .all(clientId);
  const meetings = db
    .query(
      `SELECT m.id, m.seq, m.title, m.meeting_date, m.meeting_type, m.source, m.status,
              m.audio_asset_id, m.restricted, m.created_at,
              EXISTS(SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id) AS has_transcript
       FROM meetings m
       WHERE m.client_id = ? AND m.deleted_at IS NULL
       ORDER BY m.meeting_date, m.seq`,
    )
    .all(clientId);
  const openInsights = db
    .query(
      `SELECT id, title, state, track FROM insights
       WHERE client_id = ? AND state NOT IN ${TERMINAL_STATES}
       ORDER BY priority DESC, created_at`,
    )
    .all(clientId);
  return { client, contacts, meetings, open_insights: openInsights };
}

export function addContact(
  db: Database,
  clientId: string,
  input: z.infer<typeof ContactSchema>,
): Record<string, unknown> {
  const client = db.query("SELECT id FROM clients WHERE id = ?").get(clientId);
  if (!client) throw new IngestError("Client not found", 404);
  const id = ulid();
  db.query(
    "INSERT INTO client_contacts (id, client_id, name, email, title, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, clientId, input.name, input.email ?? null, input.title ?? null, nowIso());
  return db.query("SELECT * FROM client_contacts WHERE id = ?").get(id) as Record<string, unknown>;
}

// ---------------------------------------------------------------- meetings

export interface MeetingUploadInput {
  client_id: string;
  meeting_date: string;
  title?: string;
  meeting_type?: (typeof MEETING_TYPES)[number];
  source?: (typeof MEETING_SOURCES)[number];
  attendees_json?: string;
  transcriptText?: string;
  transcriptFile?: UploadedFile;
  audioFile?: UploadedFile;
}

export interface MeetingUploadResult {
  meeting: MeetingRow;
  duplicate: boolean;
  transcript_id?: string;
  audio_asset_id?: string;
  transcript_asset_id?: string;
}

/** Content-addressed dedup (SPEC.md section 9): same bytes for the same client attach, never duplicate. */
function findDuplicateMeeting(db: Database, clientId: string, shas: string[]): MeetingRow | null {
  for (const sha of shas) {
    const viaAsset = db
      .query(
        `SELECT m.* FROM meetings m JOIN media_assets a ON a.id = m.audio_asset_id
         WHERE m.client_id = ? AND a.sha256 = ? AND m.deleted_at IS NULL`,
      )
      .get(clientId, sha) as MeetingRow | null;
    if (viaAsset) return viaAsset;
    const viaEvent = db
      .query(
        `SELECT m.* FROM meetings m JOIN events e ON e.entity_id = m.id
         WHERE e.entity_type = 'meeting' AND e.idempotency_key = ?
           AND m.client_id = ? AND m.deleted_at IS NULL`,
      )
      .get(`meeting-upload-${clientId}-${sha}`, clientId) as MeetingRow | null;
    if (viaEvent) return viaEvent;
  }
  return null;
}

export async function createMeeting(
  db: Database,
  actor: { id: string },
  input: MeetingUploadInput,
  opts: { blobDir?: string } = {},
): Promise<MeetingUploadResult> {
  const client = db.query("SELECT id FROM clients WHERE id = ?").get(input.client_id);
  if (!client) throw new IngestError("Client not found", 404);
  if (!input.transcriptText && !input.transcriptFile && !input.audioFile) {
    throw new IngestError("Provide transcript_text, transcript_file, or audio_file", 400);
  }

  // size caps before any hashing or writes
  if (input.audioFile) assertSizeOk("audio", input.audioFile.bytes.byteLength);
  if (input.transcriptFile) assertSizeOk("transcript_file", input.transcriptFile.bytes.byteLength);
  const textBytes = input.transcriptText ? new TextEncoder().encode(input.transcriptText) : null;
  if (textBytes && textBytes.byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new IngestError("Transcript text is capped at 10MB", 413);
  }

  const audioSha = input.audioFile ? sha256Hex(input.audioFile.bytes) : null;
  const transcriptFileSha = input.transcriptFile ? sha256Hex(input.transcriptFile.bytes) : null;
  const textSha = textBytes ? sha256Hex(textBytes) : null;
  const shas = [audioSha, transcriptFileSha, textSha].filter((s): s is string => s !== null);
  const primarySha = shas[0]!;

  const dup = findDuplicateMeeting(db, input.client_id, shas);
  if (dup) return { meeting: dup, duplicate: true };

  // transcript content: text field wins; transcript_file must be valid UTF-8 text.
  // Audio bytes are never decoded.
  let transcriptContent: string | null = input.transcriptText ?? null;
  if (transcriptContent === null && input.transcriptFile) {
    try {
      transcriptContent = new TextDecoder("utf-8", { fatal: true }).decode(input.transcriptFile.bytes);
    } catch {
      throw new IngestError("transcript_file must be UTF-8 text", 400);
    }
  }

  const audioAsset = input.audioFile
    ? await saveBlob(
        db,
        {
          kind: "audio",
          filename: input.audioFile.filename,
          contentType: input.audioFile.contentType,
          bytes: input.audioFile.bytes,
          uploadedBy: actor.id,
        },
        opts,
      )
    : null;
  const transcriptAsset = input.transcriptFile
    ? await saveBlob(
        db,
        {
          kind: "transcript_file",
          filename: input.transcriptFile.filename,
          contentType: input.transcriptFile.contentType,
          bytes: input.transcriptFile.bytes,
          uploadedBy: actor.id,
        },
        opts,
      )
    : null;

  const meetingId = ulid();
  const t = nowIso();
  const hasTranscript = transcriptContent !== null;

  const tx = db.transaction(() => {
    const seqRow = db
      .query("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM meetings WHERE client_id = ?")
      .get(input.client_id) as { seq: number };
    db.query(
      `INSERT INTO meetings (id, client_id, seq, title, meeting_date, meeting_type, source,
                             attendees_json, audio_asset_id, consent_confirmed, status, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      meetingId,
      input.client_id,
      seqRow.seq,
      input.title ?? null,
      input.meeting_date,
      input.meeting_type ?? null,
      input.source ?? "manual",
      input.attendees_json ?? null,
      audioAsset?.id ?? null,
      hasTranscript ? "transcribed" : "uploaded",
      actor.id,
      t,
    );
    let transcriptId: string | null = null;
    if (hasTranscript) {
      transcriptId = ulid();
      // content is the canonical CLEANED transcript (what extraction anchors
      // quotes/offsets to); raw_content keeps the upload byte-for-byte.
      db.query(
        "INSERT INTO transcripts (id, meeting_id, content, raw_content, source, created_at) VALUES (?, ?, ?, ?, 'uploaded', ?)",
      ).run(transcriptId, meetingId, cleanTranscript(transcriptContent!), transcriptContent, t);
      syncTranscriptFts(db, transcriptId);
    }
    appendEvent(db, {
      actorUserId: actor.id,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.uploaded",
      idempotencyKey: `meeting-upload-${input.client_id}-${primarySha}`,
      payload: {
        client_id: input.client_id,
        source: input.source ?? "manual",
        seq: seqRow.seq,
        ...(audioAsset ? { audio_asset_id: audioAsset.id } : {}),
        ...(transcriptAsset ? { transcript_asset_id: transcriptAsset.id } : {}),
      },
    });
    return transcriptId;
  });
  const transcriptId = tx() as string | null;

  const meeting = db.query("SELECT * FROM meetings WHERE id = ?").get(meetingId) as MeetingRow;
  return {
    meeting,
    duplicate: false,
    ...(transcriptId ? { transcript_id: transcriptId } : {}),
    ...(audioAsset ? { audio_asset_id: audioAsset.id } : {}),
    ...(transcriptAsset ? { transcript_asset_id: transcriptAsset.id } : {}),
  };
}

export function listMeetings(db: Database, clientId: string | null): Record<string, unknown>[] {
  return db
    .query(
      `SELECT m.id, m.client_id, c.name AS client_name, m.seq, m.title, m.meeting_date,
              m.meeting_type, m.source, m.status, m.audio_asset_id, m.restricted, m.created_at,
              EXISTS(SELECT 1 FROM transcripts t WHERE t.meeting_id = m.id) AS has_transcript
       FROM meetings m
       LEFT JOIN clients c ON c.id = m.client_id
       WHERE (?1 IS NULL OR m.client_id = ?1) AND m.deleted_at IS NULL
       ORDER BY m.meeting_date DESC, m.seq DESC`,
    )
    .all(clientId) as Record<string, unknown>[];
}

export function getMeetingDetail(db: Database, meetingId: string): Record<string, unknown> | null {
  const meeting = db
    .query("SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) return null;
  const transcripts = db
    .query("SELECT id, source, quality_flag, created_at FROM transcripts WHERE meeting_id = ? ORDER BY created_at")
    .all(meetingId);
  const insights = db
    .query("SELECT id, title, state FROM insights WHERE meeting_id = ? ORDER BY created_at")
    .all(meetingId);
  return {
    meeting,
    has_transcript: transcripts.length > 0,
    transcripts,
    insights,
  };
}

/** Manual paste path for audio-only meetings (SPEC.md section 2 fallback). */
export function addPastedTranscript(
  db: Database,
  actor: { id: string },
  meetingId: string,
  text: string,
): { transcript_id: string; meeting: MeetingRow } {
  const meeting = db
    .query("SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL")
    .get(meetingId) as MeetingRow | null;
  if (!meeting) throw new IngestError("Meeting not found", 404);
  if (new TextEncoder().encode(text).byteLength > MAX_TRANSCRIPT_BYTES) {
    throw new IngestError("Transcript text is capped at 10MB", 413);
  }

  const transcriptId = ulid();
  const t = nowIso();
  const tx = db.transaction(() => {
    db.query(
      "INSERT INTO transcripts (id, meeting_id, content, raw_content, source, created_at) VALUES (?, ?, ?, ?, 'pasted', ?)",
    ).run(transcriptId, meetingId, cleanTranscript(text), text, t);
    syncTranscriptFts(db, transcriptId);
    db.query(
      "UPDATE meetings SET status = 'transcribed' WHERE id = ? AND status IN ('uploaded','transcribing','transcription_failed')",
    ).run(meetingId);
    appendEvent(db, {
      actorUserId: actor.id,
      entityType: "meeting",
      entityId: meetingId,
      eventType: "meeting.transcript_added",
      payload: { transcript_id: transcriptId, source: "pasted" },
    });
  });
  tx();
  return {
    transcript_id: transcriptId,
    meeting: db.query("SELECT * FROM meetings WHERE id = ?").get(meetingId) as MeetingRow,
  };
}

// ---------------------------------------------------------------- media download

function owningMeeting(db: Database, assetId: string): MeetingRow | null {
  const viaAudio = db
    .query("SELECT * FROM meetings WHERE audio_asset_id = ?")
    .get(assetId) as MeetingRow | null;
  if (viaAudio) return viaAudio;
  // transcript files have no FK on meetings; the meeting.uploaded event payload links them
  return db
    .query(
      `SELECT m.* FROM meetings m JOIN events e ON e.entity_id = m.id
       WHERE e.entity_type = 'meeting' AND e.event_type = 'meeting.uploaded' AND e.payload_json LIKE ?`,
    )
    .get(`%"${assetId}"%`) as MeetingRow | null;
}

export function downloadMedia(
  db: Database,
  user: AuthedUser,
  assetId: string,
  opts: { blobDir?: string } = {},
): Response {
  const asset = db.query("SELECT * FROM media_assets WHERE id = ?").get(assetId) as MediaAsset | null;
  if (!asset) return json({ error: "Media asset not found" }, 404);

  const meeting = owningMeeting(db, assetId);
  if (meeting && meeting.restricted === 1 && user.role !== "admin") {
    let allowed: unknown = [];
    try {
      allowed = JSON.parse(meeting.allowed_users_json ?? "[]");
    } catch {
      allowed = [];
    }
    if (!Array.isArray(allowed) || !allowed.includes(user.id)) {
      return json({ error: "This recording is restricted" }, 403);
    }
  }

  const path = getBlobPath(asset, opts.blobDir);
  if (!existsSync(path)) return json({ error: "Blob missing from storage" }, 404);
  return new Response(Bun.file(path), {
    headers: {
      "content-type": asset.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${asset.filename.replace(/["\\\r\n]/g, "")}"`,
    },
  });
}

// ---------------------------------------------------------------- HTTP handlers

function errorResponse(e: unknown): Response {
  if (e instanceof IngestError) return json({ error: e.message }, e.status);
  throw e;
}

async function readJsonBody(req: Request): Promise<unknown | Response> {
  try {
    return await req.json();
  } catch {
    return json({ error: "Request body must be valid JSON" }, 400);
  }
}

function asUploadedFile(v: FormDataEntryValue | null): Promise<UploadedFile | null> {
  if (v === null || typeof v === "string") return Promise.resolve(null);
  return v
    .arrayBuffer()
    .then((buf) => ({ filename: v.name, contentType: v.type || null, bytes: new Uint8Array(buf) }));
}

export async function handleCreateClient(db: Database, user: AuthedUser, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const parsed = ClientCreateSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  return json(createClient(db, user.id, parsed.data), 201);
}

export function handleListClients(db: Database): Response {
  return json({ clients: listClients(db) });
}

export function handleGetClient(db: Database, clientId: string): Response {
  const detail = getClientDetail(db, clientId);
  if (!detail) return json({ error: "Client not found" }, 404);
  return json(detail);
}

export async function handleAddContact(
  db: Database,
  _user: AuthedUser,
  clientId: string,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const parsed = ContactSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  try {
    return json(addContact(db, clientId, parsed.data), 201);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function handleCreateMeeting(
  db: Database,
  user: AuthedUser,
  req: Request,
  opts: { blobDir?: string } = {},
): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data" }, 400);
  }

  // SPEC.md section 10: processing is blocked until consent is recorded
  if (form.get("consent_confirmed") !== "true") {
    return json(
      {
        error:
          'consent_confirmed must be the string "true". Client recordings cannot be processed until consent is recorded (SPEC section 10).',
      },
      400,
    );
  }

  const fields: Record<string, string> = {};
  for (const key of ["client_id", "meeting_date", "title", "meeting_type", "source", "attendees_json"]) {
    const v = form.get(key);
    if (typeof v === "string" && v !== "") fields[key] = v;
  }
  const parsed = MeetingFieldsSchema.safeParse(fields);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  if (parsed.data.attendees_json) {
    try {
      JSON.parse(parsed.data.attendees_json);
    } catch {
      return json({ error: "attendees_json must be valid JSON" }, 400);
    }
  }

  const rawText = form.get("transcript_text");
  const transcriptText = typeof rawText === "string" && rawText.trim() !== "" ? rawText : undefined;
  const transcriptFile = await asUploadedFile(form.get("transcript_file"));
  const audioFile = await asUploadedFile(form.get("audio_file"));

  try {
    const result = await createMeeting(
      db,
      user,
      {
        ...parsed.data,
        transcriptText,
        transcriptFile: transcriptFile ?? undefined,
        audioFile: audioFile ?? undefined,
      },
      opts,
    );
    return json(result, result.duplicate ? 200 : 201);
  } catch (e) {
    return errorResponse(e);
  }
}

export function handleListMeetings(db: Database, req: Request): Response {
  const clientId = new URL(req.url).searchParams.get("client_id");
  return json({ meetings: listMeetings(db, clientId) });
}

export function handleGetMeeting(db: Database, meetingId: string): Response {
  const detail = getMeetingDetail(db, meetingId);
  if (!detail) return json({ error: "Meeting not found" }, 404);
  return json(detail);
}

export async function handleAddTranscript(
  db: Database,
  user: AuthedUser,
  meetingId: string,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) return body;
  const parsed = TranscriptPasteSchema.safeParse(body);
  if (!parsed.success) return json({ error: "Invalid request", issues: parsed.error.issues }, 400);
  try {
    return json(addPastedTranscript(db, user, meetingId, parsed.data.text), 201);
  } catch (e) {
    return errorResponse(e);
  }
}

export function handleDownloadMedia(
  db: Database,
  user: AuthedUser,
  assetId: string,
  opts: { blobDir?: string } = {},
): Response {
  try {
    return downloadMedia(db, user, assetId, opts);
  } catch (e) {
    return errorResponse(e);
  }
}
