/**
 * Offscreen document: the only MV3 context that can run getUserMedia and
 * MediaRecorder. It consumes the tabCapture streamId handed over by the
 * service worker, records the tab audio as webm/opus, routes the captured
 * stream through an AudioContext gain node so the tab stays audible, and
 * uploads the finished blob straight to the Followthrough server.
 *
 * Uploading from here (instead of relaying to the SW) avoids shipping the
 * blob through chrome.runtime messages, which JSON-serialize payloads.
 */
import type { OffscreenMessage, OffscreenStartPayload, RecState } from "./types.ts";

let stream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let meta: { clientId: string; clientName: string; title: string; baseUrl: string } | null = null;
let pendingBlob: Blob | null = null;
let stopping = false;

/** Push a state update to the service worker, the single state writer. */
function pushState(payload: Partial<RecState>): void {
  chrome.runtime
    .sendMessage({ target: "background", type: "OFFSCREEN_STATE", payload })
    .catch(() => {
      // SW asleep; it re-reads chrome.storage.session on wake anyway
    });
}

function todayIso(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

async function start(payload: OffscreenStartPayload): Promise<void> {
  if (recorder) throw new Error("Already recording.");
  meta = {
    clientId: payload.clientId,
    clientName: payload.clientName,
    title: payload.title,
    baseUrl: payload.baseUrl,
  };
  chunks = [];
  pendingBlob = null;
  stopping = false;

  // chromeMediaSource constraints are non-standard, hence the cast.
  stream = await (navigator.mediaDevices.getUserMedia as unknown as (
    c: unknown,
  ) => Promise<MediaStream>)({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: payload.streamId,
      },
    },
    video: false,
  });

  // Passthrough: tabCapture mutes the tab for the user unless we route the
  // captured audio back out. Source -> gain -> destination keeps the call
  // audible while we record it.
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  source.connect(gain);
  gain.connect(audioCtx.destination);

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (ev: BlobEvent) => {
    if (ev.data.size > 0) chunks.push(ev.data);
  };
  recorder.onstop = () => {
    void finalize();
  };
  recorder.start(1000);

  // Tab closed or capture revoked mid-call: finalize with what we have.
  const track = stream.getAudioTracks()[0];
  if (track) track.addEventListener("ended", () => stopRecording());
}

function stopRecording(): void {
  if (!recorder || recorder.state === "inactive" || stopping) return;
  stopping = true;
  recorder.stop(); // onstop -> finalize -> upload
}

async function finalize(): Promise<void> {
  const recordedType = recorder?.mimeType || "audio/webm";
  recorder = null;
  stopping = false;
  teardownAudio();
  pendingBlob = new Blob(chunks, { type: recordedType.split(";")[0] || "audio/webm" });
  chunks = [];
  await upload();
}

function teardownAudio(): void {
  if (audioCtx) {
    void audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
}

/**
 * Put the recording on the meeting form. The hosted app hands out a signed
 * storage URL (functions cap request bodies at 4.5 MB), so the audio goes
 * straight to storage and the form carries its key; a self-hosted server that
 * cannot sign uploads takes the file in the form as before.
 */
async function attachAudio(baseUrl: string, form: FormData, blob: Blob, filename: string): Promise<void> {
  const start = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, content_type: blob.type || undefined, size_bytes: blob.size }),
  });
  // 404: an older server without direct uploads.
  if (start.status === 404) {
    form.set("audio_file", blob, filename);
    return;
  }
  if (start.status === 401) throw new Error("Session expired. Log in again from the popup.");
  if (!start.ok) throw new Error(`could not start the upload (${start.status})`);
  const s = (await start.json()) as { mode: string; key?: string; upload_url?: string };
  if (s.mode !== "direct" || !s.key || !s.upload_url) {
    form.set("audio_file", blob, filename);
    return;
  }
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const put = await fetch(s.upload_url, {
    method: "PUT",
    headers: { "content-type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!put.ok) throw new Error(`storage rejected the recording (${put.status})`);
  form.set("audio_upload_key", s.key);
  form.set("audio_sha256", sha);
  form.set("audio_filename", filename);
  if (blob.type) form.set("audio_content_type", blob.type);
  form.set("audio_size", String(blob.size));
}

async function upload(): Promise<void> {
  if (!meta || !pendingBlob) {
    pushState({ phase: "error", error: "Nothing to upload.", canRetry: false });
    return;
  }
  if (pendingBlob.size === 0) {
    pushState({
      phase: "error",
      error: "No audio was captured from the tab. Was anything playing?",
      canRetry: false,
    });
    return;
  }

  pushState({ phase: "uploading" });

  const fd = new FormData();
  fd.set("client_id", meta.clientId);
  fd.set("meeting_date", todayIso());
  fd.set("title", meta.title.trim() || `Recorded meeting ${todayIso()}`);
  fd.set("source", "extension");
  fd.set("consent_confirmed", "true");

  let res: Response;
  try {
    await attachAudio(meta.baseUrl, fd, pendingBlob, `meeting-${Date.now()}.webm`);
    res = await fetch(`${meta.baseUrl}/api/meetings`, {
      method: "POST",
      body: fd,
      credentials: "include",
    });
  } catch (err) {
    pushState({
      phase: "error",
      error: `Upload failed: ${String(err)}. Is the server running at ${meta.baseUrl}?`,
      canRetry: true,
    });
    return;
  }

  if (res.status === 401) {
    pushState({
      phase: "error",
      error: "Session expired. Log in again from the popup, then press Retry upload.",
      canRetry: true,
    });
    return;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    pushState({
      phase: "error",
      error: `Upload rejected (${res.status}): ${body.slice(0, 200)}`,
      canRetry: true,
    });
    return;
  }

  const body = (await res.json().catch(() => null)) as
    | { meeting?: { id?: string }; duplicate?: boolean }
    | null;
  pendingBlob = null; // uploaded; nothing left to retry
  pushState({
    phase: "done",
    meetingId: body?.meeting?.id,
    duplicate: body?.duplicate === true,
  });
}

function discard(): void {
  if (recorder && recorder.state !== "inactive") {
    recorder.ondataavailable = null;
    recorder.onstop = null;
    try {
      recorder.stop();
    } catch {
      // already stopped
    }
  }
  recorder = null;
  stopping = false;
  teardownAudio();
  chunks = [];
  pendingBlob = null;
  meta = null;
}

// Single onMessage listener for this context. Messages addressed to the
// service worker carry target:"background" and are ignored here so the SW
// hub owns their response channel (see background.ts for the gotcha).
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as OffscreenMessage;
  if (!msg || (msg as { target?: string }).target !== "offscreen") return false;

  switch (msg.type) {
    case "OFFSCREEN_START":
      start(msg.payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          discard();
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    case "OFFSCREEN_STOP":
      stopRecording();
      sendResponse({ ok: true });
      return false;
    case "OFFSCREEN_RETRY":
      void upload();
      sendResponse({ ok: true });
      return false;
    case "OFFSCREEN_DISCARD":
      discard();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});
