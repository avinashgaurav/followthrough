/**
 * MV3 service worker for the Insights Engine Recorder.
 *
 * Responsibilities:
 * - Resolve a tabCapture streamId for the active tab (only the SW may call
 *   chrome.tabCapture.getMediaStreamId).
 * - Manage the offscreen document lifecycle (the only context that can run
 *   getUserMedia + MediaRecorder in MV3).
 * - Hold the canonical recording state in chrome.storage.session so the
 *   popup can close and reopen mid-recording.
 */
import type { Ack, BgMessage, RecState, StartRecordingPayload } from "./types.ts";

const OFFSCREEN_URL = "offscreen.html";
const STATE_KEY = "rec_state";

async function getState(): Promise<RecState> {
  const obj = await chrome.storage.session.get(STATE_KEY);
  return (obj[STATE_KEY] as RecState | undefined) ?? { phase: "idle" };
}

async function setState(state: RecState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function hasOffscreen(): Promise<boolean> {
  try {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    return ctxs.length > 0;
  } catch {
    return false;
  }
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["AUDIO_PLAYBACK"],
    justification:
      "Keeps the recorded tab audible by routing its captured audio to the speakers while recording it for upload to Insights Engine.",
  });
}

async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return;
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
}

function streamIdForTab(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? "tabCapture returned no stream id"));
      else resolve(id);
    });
  });
}

async function handleStart(payload: StartRecordingPayload): Promise<Ack> {
  const cur = await getState();
  if (cur.phase === "recording" || cur.phase === "uploading") {
    return { ok: false, error: "A recording is already in progress." };
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return { ok: false, error: "No active tab to record." };

  const streamId = await streamIdForTab(tab.id);
  await ensureOffscreen();

  const ack = (await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_START",
    payload: { ...payload, streamId },
  })) as Ack | undefined;

  if (!ack?.ok) {
    await closeOffscreen();
    return { ok: false, error: ack?.error ?? "Offscreen recorder did not start." };
  }

  const state: RecState = {
    phase: "recording",
    startedAt: Date.now(),
    clientId: payload.clientId,
    clientName: payload.clientName,
    title: payload.title,
  };
  await setState(state);
  return { ok: true, state };
}

async function handleStop(): Promise<Ack> {
  const cur = await getState();
  if (cur.phase !== "recording") return { ok: false, error: "Not recording." };
  try {
    await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_STOP" });
  } catch (err) {
    await setState({ phase: "error", error: `Recorder unreachable: ${String(err)}` });
    return { ok: false, error: String(err) };
  }
  // The offscreen doc pushes OFFSCREEN_STATE (uploading -> done | error) from here.
  return { ok: true };
}

async function handleRetry(): Promise<Ack> {
  if (!(await hasOffscreen())) {
    await setState({ phase: "error", error: "The recording is no longer held in memory. Record again." });
    return { ok: false, error: "Nothing left to retry." };
  }
  await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_RETRY" });
  return { ok: true };
}

async function handleReset(): Promise<Ack> {
  if (await hasOffscreen()) {
    try {
      await chrome.runtime.sendMessage({ target: "offscreen", type: "OFFSCREEN_DISCARD" });
    } catch {
      // offscreen may have gone away on its own
    }
    await closeOffscreen();
  }
  await setState({ phase: "idle" });
  return { ok: true };
}

async function handleOffscreenState(payload: Partial<RecState>): Promise<Ack> {
  const cur = await getState();
  const next = { ...cur, ...payload } as RecState;
  await setState(next);
  // Upload finished: the blob is on the server, the offscreen doc is done.
  if (next.phase === "done") await closeOffscreen();
  return { ok: true };
}

// ─── Single message hub ──────────────────────────────────────────────────
// IMPORTANT: exactly ONE chrome.runtime.onMessage.addListener may exist in
// this service worker. Chrome closes the response channel as soon as any
// listener returns a falsy value, so a second listener registered later
// never gets a chance to call sendResponse for message types the first
// listener does not recognise. All SW message handling lives here.
// Messages addressed to the offscreen document carry target:"offscreen"
// and are ignored here (return false) so the offscreen listener owns the
// response channel for them.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const msg = message as BgMessage;
  if (!msg || (msg as { target?: string }).target !== "background") return false;

  const respond = (work: Promise<Ack>): void => {
    work
      .then((ack) => sendResponse(ack))
      .catch((err) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  };

  switch (msg.type) {
    case "START_RECORDING":
      respond(handleStart(msg.payload));
      return true;
    case "STOP_RECORDING":
      respond(handleStop());
      return true;
    case "RETRY_UPLOAD":
      respond(handleRetry());
      return true;
    case "RESET":
      respond(handleReset());
      return true;
    case "GET_STATE":
      respond(getState().then((state) => ({ ok: true, state })));
      return true;
    case "OFFSCREEN_STATE":
      respond(handleOffscreenState(msg.payload));
      return true;
    default:
      return false;
  }
});
