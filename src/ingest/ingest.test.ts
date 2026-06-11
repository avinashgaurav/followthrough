import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "../db.ts";
import { ulid } from "../ids.ts";
import type { AuthedUser } from "../auth.ts";
import {
  handleAddContact,
  handleAddTranscript,
  handleCreateClient,
  handleCreateMeeting,
  handleDownloadMedia,
  handleGetClient,
  handleGetMeeting,
  handleListClients,
  handleListMeetings,
  type MeetingRow,
} from "./service.ts";

const blobDir = mkdtempSync(join(tmpdir(), "ie-ingest-test-"));
afterAll(() => rmSync(blobDir, { recursive: true, force: true }));

function seedUser(db: Database, role: "admin" | "member" = "member"): AuthedUser {
  const id = ulid();
  db.query("INSERT INTO users (id, email, name, role, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    `u-${id}@xyz.com`,
    "Test User",
    role,
    nowIso(),
  );
  return { id, email: `u-${id}@xyz.com`, name: "Test User", role };
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createClientViaApi(db: Database, user: AuthedUser, name = "Acme"): Promise<string> {
  const res = await handleCreateClient(db, user, jsonRequest("/api/clients", { name }));
  const body = (await res.json()) as { client: { id: string } };
  return body.client.id;
}

function meetingRequest(fields: Record<string, string | File>): Request {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return new Request("http://localhost/api/meetings", { method: "POST", body: fd });
}

function uploadedEventCount(db: Database, meetingId?: string): number {
  const row = (
    meetingId
      ? db
          .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'meeting.uploaded' AND entity_id = ?")
          .get(meetingId)
      : db.query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'meeting.uploaded'").get()
  ) as { n: number };
  return row.n;
}

const AUDIO_BYTES = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x80, 0x44, 0x55]);

describe("clients", () => {
  test("create client with contacts, then list with counts", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const res = await handleCreateClient(
      db,
      user,
      jsonRequest("/api/clients", {
        name: "Globex",
        domain: "globex.com",
        contacts: [{ name: "Hank Scorpio", email: "hank@globex.com", title: "CEO" }],
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client: Record<string, unknown>; contacts: Record<string, unknown>[] };
    expect(body.client.name).toBe("Globex");
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0]!.email).toBe("hank@globex.com");

    const listRes = handleListClients(db);
    const list = (await listRes.json()) as { clients: Record<string, unknown>[] };
    expect(list.clients).toHaveLength(1);
    expect(list.clients[0]!.meetings_count).toBe(0);
    expect(list.clients[0]!.open_insights_count).toBe(0);
  });

  test("create client rejects an empty name", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const res = await handleCreateClient(db, user, jsonRequest("/api/clients", { name: "" }));
    expect(res.status).toBe(400);
  });

  test("add contact to existing client; 404 for unknown client", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const ok = await handleAddContact(
      db,
      user,
      clientId,
      jsonRequest(`/api/clients/${clientId}/contacts`, { name: "Pam", email: "pam@acme.com" }),
    );
    expect(ok.status).toBe(201);
    const missing = await handleAddContact(
      db,
      user,
      "NOPE",
      jsonRequest("/api/clients/NOPE/contacts", { name: "Pam" }),
    );
    expect(missing.status).toBe(404);
  });

  test("client detail: meetings ordered with seq, open insights rollup excludes terminal states", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);

    for (const [date, text] of [
      ["2026-06-01", "first call"],
      ["2026-06-08", "second call"],
    ] as const) {
      const res = await handleCreateMeeting(
        db,
        user,
        meetingRequest({ client_id: clientId, meeting_date: date, consent_confirmed: "true", transcript_text: text }),
        { blobDir },
      );
      expect(res.status).toBe(201);
    }

    const meetingId = (
      db.query("SELECT id FROM meetings WHERE client_id = ? AND seq = 1").get(clientId) as { id: string }
    ).id;
    const t = nowIso();
    for (const state of ["extracted", "triaged", "closed", "rejected", "merged"]) {
      db.query(
        `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, state, created_at, updated_at)
         VALUES (?, ?, ?, 'feature_request', ?, 'o', 'o', ?, ?, ?)`,
      ).run(ulid(), meetingId, clientId, `Ask in ${state}`, state, t, t);
    }

    const res = handleGetClient(db, clientId);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as {
      meetings: { seq: number; has_transcript: number }[];
      open_insights: { state: string; track: string | null }[];
    };
    expect(detail.meetings.map((m) => m.seq)).toEqual([1, 2]);
    expect(detail.meetings[0]!.has_transcript).toBe(1);
    expect(detail.open_insights).toHaveLength(2);
    expect(detail.open_insights.map((i) => i.state).sort()).toEqual(["extracted", "triaged"]);

    expect(handleGetClient(db, "NOPE").status).toBe(404);
  });
});

describe("meeting upload", () => {
  test("transcript upload: status transcribed, seq 1, event written exactly once", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({
        client_id: clientId,
        meeting_date: "2026-06-09",
        title: "Discovery call",
        meeting_type: "discovery",
        source: "meet",
        consent_confirmed: "true",
        transcript_text: "Client: we need SSO before rollout.",
      }),
      { blobDir },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { meeting: MeetingRow; duplicate: boolean; transcript_id?: string };
    expect(body.duplicate).toBe(false);
    expect(body.meeting.status).toBe("transcribed");
    expect(body.meeting.seq).toBe(1);
    expect(body.meeting.consent_confirmed).toBe(1);
    expect(body.transcript_id).toBeTruthy();

    const transcript = db
      .query("SELECT source, content FROM transcripts WHERE meeting_id = ?")
      .get(body.meeting.id) as { source: string; content: string };
    expect(transcript.source).toBe("uploaded");
    expect(transcript.content).toContain("SSO");

    expect(uploadedEventCount(db, body.meeting.id)).toBe(1);
    const event = db
      .query("SELECT payload_json, idempotency_key FROM events WHERE event_type = 'meeting.uploaded'")
      .get() as { payload_json: string; idempotency_key: string };
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    expect(payload.client_id).toBe(clientId);
    expect(payload.source).toBe("meet");
    expect(payload.seq).toBe(1);
    expect(event.idempotency_key).toStartWith("meeting-upload-");
  });

  test("same bytes again returns duplicate:true and creates nothing", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const fields = {
      client_id: clientId,
      meeting_date: "2026-06-09",
      consent_confirmed: "true",
      transcript_text: "Client: we need SSO before rollout.",
    };
    const first = await handleCreateMeeting(db, user, meetingRequest(fields), { blobDir });
    const firstBody = (await first.json()) as { meeting: MeetingRow };

    const second = await handleCreateMeeting(db, user, meetingRequest(fields), { blobDir });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { meeting: MeetingRow; duplicate: boolean };
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.meeting.id).toBe(firstBody.meeting.id);

    const meetings = db.query("SELECT COUNT(*) AS n FROM meetings WHERE client_id = ?").get(clientId) as { n: number };
    expect(meetings.n).toBe(1);
    expect(uploadedEventCount(db)).toBe(1);
    const transcripts = db.query("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number };
    expect(transcripts.n).toBe(1);
  });

  test("a second distinct meeting gets seq 2", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientId, meeting_date: "2026-06-01", consent_confirmed: "true", transcript_text: "call one" }),
      { blobDir },
    );
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientId, meeting_date: "2026-06-08", consent_confirmed: "true", transcript_text: "call two" }),
      { blobDir },
    );
    const body = (await res.json()) as { meeting: MeetingRow; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    expect(body.meeting.seq).toBe(2);
    expect(uploadedEventCount(db)).toBe(2);
  });

  test("missing or false consent_confirmed is rejected with a clear message", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const noConsent = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientId, meeting_date: "2026-06-09", transcript_text: "hi" }),
      { blobDir },
    );
    expect(noConsent.status).toBe(400);
    const body = (await noConsent.json()) as { error: string };
    expect(body.error).toContain("consent_confirmed");

    const falseConsent = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientId, meeting_date: "2026-06-09", consent_confirmed: "false", transcript_text: "hi" }),
      { blobDir },
    );
    expect(falseConsent.status).toBe(400);
    expect(uploadedEventCount(db)).toBe(0);
    const meetings = db.query("SELECT COUNT(*) AS n FROM meetings").get() as { n: number };
    expect(meetings.n).toBe(0);
  });

  test("transcript_file upload saves the asset and stores its text", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({
        client_id: clientId,
        meeting_date: "2026-06-09",
        consent_confirmed: "true",
        transcript_file: new File(["Speaker 1: shipping is slow."], "fireflies.txt", { type: "text/plain" }),
      }),
      { blobDir },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { meeting: MeetingRow; transcript_asset_id?: string };
    expect(body.meeting.status).toBe("transcribed");
    expect(body.transcript_asset_id).toBeTruthy();
    const asset = db.query("SELECT kind, filename FROM media_assets WHERE id = ?").get(body.transcript_asset_id!) as {
      kind: string;
      filename: string;
    };
    expect(asset.kind).toBe("transcript_file");
    expect(asset.filename).toBe("fireflies.txt");
    const transcript = db.query("SELECT content, source FROM transcripts WHERE meeting_id = ?").get(body.meeting.id) as {
      content: string;
      source: string;
    };
    expect(transcript.content).toBe("Speaker 1: shipping is slow.");
    expect(transcript.source).toBe("uploaded");
  });

  test("rejects when no transcript or audio provided, and unknown client 404s", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const empty = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientId, meeting_date: "2026-06-09", consent_confirmed: "true" }),
      { blobDir },
    );
    expect(empty.status).toBe(400);

    const ghost = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: "NOPE", meeting_date: "2026-06-09", consent_confirmed: "true", transcript_text: "hi" }),
      { blobDir },
    );
    expect(ghost.status).toBe(404);
  });

  test("invalid meeting_type is rejected before any insert", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({
        client_id: clientId,
        meeting_date: "2026-06-09",
        meeting_type: "standup",
        consent_confirmed: "true",
        transcript_text: "hi",
      }),
      { blobDir },
    );
    expect(res.status).toBe(400);
  });
});

describe("audio-only path", () => {
  test("audio upload stays 'uploaded'; pasted transcript flips to 'transcribed'", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({
        client_id: clientId,
        meeting_date: "2026-06-09",
        consent_confirmed: "true",
        audio_file: new File([AUDIO_BYTES], "call.mp3", { type: "audio/mpeg" }),
      }),
      { blobDir },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { meeting: MeetingRow; audio_asset_id?: string };
    expect(body.meeting.status).toBe("uploaded");
    expect(body.audio_asset_id).toBeTruthy();
    expect(body.meeting.audio_asset_id).toBe(body.audio_asset_id!);
    const transcripts = db.query("SELECT COUNT(*) AS n FROM transcripts").get() as { n: number };
    expect(transcripts.n).toBe(0);

    const paste = await handleAddTranscript(
      db,
      user,
      body.meeting.id,
      jsonRequest(`/api/meetings/${body.meeting.id}/transcript`, { text: "Manual transcript of the call." }),
    );
    expect(paste.status).toBe(201);
    const pasted = (await paste.json()) as { meeting: MeetingRow; transcript_id: string };
    expect(pasted.meeting.status).toBe("transcribed");
    const transcript = db.query("SELECT source FROM transcripts WHERE id = ?").get(pasted.transcript_id) as {
      source: string;
    };
    expect(transcript.source).toBe("pasted");
    const evt = db
      .query("SELECT COUNT(*) AS n FROM events WHERE event_type = 'meeting.transcript_added' AND entity_id = ?")
      .get(body.meeting.id) as { n: number };
    expect(evt.n).toBe(1);
  });

  test("same audio bytes for the same client dedupe via sha256", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const upload = () =>
      handleCreateMeeting(
        db,
        user,
        meetingRequest({
          client_id: clientId,
          meeting_date: "2026-06-09",
          consent_confirmed: "true",
          audio_file: new File([AUDIO_BYTES], "call.mp3", { type: "audio/mpeg" }),
        }),
        { blobDir },
      );
    const first = (await (await upload()).json()) as { meeting: MeetingRow };
    const second = (await (await upload()).json()) as { meeting: MeetingRow; duplicate: boolean };
    expect(second.duplicate).toBe(true);
    expect(second.meeting.id).toBe(first.meeting.id);
    const meetings = db.query("SELECT COUNT(*) AS n FROM meetings").get() as { n: number };
    expect(meetings.n).toBe(1);
  });

  test("paste transcript on unknown meeting 404s", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const res = await handleAddTranscript(db, user, "NOPE", jsonRequest("/api/meetings/NOPE/transcript", { text: "x" }));
    expect(res.status).toBe(404);
  });
});

describe("meeting reads", () => {
  test("list by client and detail with transcript presence and insights", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientA = await createClientViaApi(db, user, "Acme");
    const clientB = await createClientViaApi(db, user, "Globex");
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({ client_id: clientA, meeting_date: "2026-06-09", consent_confirmed: "true", transcript_text: "hi" }),
      { blobDir },
    );
    const body = (await res.json()) as { meeting: MeetingRow };

    const listA = (await handleListMeetings(
      db,
      new Request(`http://localhost/api/meetings?client_id=${clientA}`),
    ).json()) as { meetings: unknown[] };
    expect(listA.meetings).toHaveLength(1);
    const listB = (await handleListMeetings(
      db,
      new Request(`http://localhost/api/meetings?client_id=${clientB}`),
    ).json()) as { meetings: unknown[] };
    expect(listB.meetings).toHaveLength(0);

    const t = nowIso();
    db.query(
      `INSERT INTO insights (id, meeting_id, client_id, item_type, title, body_original, body_current, created_at, updated_at)
       VALUES (?, ?, ?, 'complaint', 'Slow exports', 'o', 'o', ?, ?)`,
    ).run(ulid(), body.meeting.id, clientA, t, t);

    const detailRes = handleGetMeeting(db, body.meeting.id);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as {
      has_transcript: boolean;
      insights: { title: string; state: string }[];
    };
    expect(detail.has_transcript).toBe(true);
    expect(detail.insights).toHaveLength(1);
    expect(detail.insights[0]!.title).toBe("Slow exports");

    expect(handleGetMeeting(db, "NOPE").status).toBe(404);
  });
});

describe("media download", () => {
  async function uploadAudioMeeting(db: Database, user: AuthedUser, clientId: string) {
    const res = await handleCreateMeeting(
      db,
      user,
      meetingRequest({
        client_id: clientId,
        meeting_date: "2026-06-09",
        consent_confirmed: "true",
        audio_file: new File([AUDIO_BYTES], "call.mp3", { type: "audio/mpeg" }),
      }),
      { blobDir },
    );
    return (await res.json()) as { meeting: MeetingRow; audio_asset_id: string };
  }

  test("streams the blob with its content type", async () => {
    const db = openTestDb();
    const user = seedUser(db);
    const clientId = await createClientViaApi(db, user);
    const { audio_asset_id } = await uploadAudioMeeting(db, user, clientId);
    const res = handleDownloadMedia(db, user, audio_asset_id, { blobDir });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(AUDIO_BYTES);
  });

  test("404 for unknown asset", () => {
    const db = openTestDb();
    const user = seedUser(db);
    expect(handleDownloadMedia(db, user, "NOPE", { blobDir }).status).toBe(404);
  });

  test("restricted meeting blocks members not on the allowlist; admin and listed users pass", async () => {
    const db = openTestDb();
    const uploader = seedUser(db);
    const allowedUser = seedUser(db);
    const admin = seedUser(db, "admin");
    const clientId = await createClientViaApi(db, uploader);
    const { meeting, audio_asset_id } = await uploadAudioMeeting(db, uploader, clientId);

    db.query("UPDATE meetings SET restricted = 1, allowed_users_json = ? WHERE id = ?").run(
      JSON.stringify([allowedUser.id]),
      meeting.id,
    );

    expect(handleDownloadMedia(db, uploader, audio_asset_id, { blobDir }).status).toBe(403);
    expect(handleDownloadMedia(db, allowedUser, audio_asset_id, { blobDir }).status).toBe(200);
    expect(handleDownloadMedia(db, admin, audio_asset_id, { blobDir }).status).toBe(200);
  });
});
