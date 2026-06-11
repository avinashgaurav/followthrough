/** Recording lifecycle as shown in the popup. */
export type Phase = "idle" | "recording" | "uploading" | "done" | "error";

/**
 * Shared recording state. The service worker is the single writer; it
 * persists this to chrome.storage.session so the popup can close and
 * reopen mid-recording without losing the UI state.
 */
export interface RecState {
  phase: Phase;
  startedAt?: number;
  clientId?: string;
  clientName?: string;
  title?: string;
  meetingId?: string;
  duplicate?: boolean;
  error?: string;
  /** True when the recorded blob is still held in the offscreen doc and upload can be retried. */
  canRetry?: boolean;
}

export interface StartRecordingPayload {
  clientId: string;
  clientName: string;
  title: string;
}

export interface OffscreenStartPayload extends StartRecordingPayload {
  streamId: string;
}

/** Messages handled by the service worker's single onMessage hub. */
export type BgMessage =
  | { target: "background"; type: "START_RECORDING"; payload: StartRecordingPayload }
  | { target: "background"; type: "STOP_RECORDING" }
  | { target: "background"; type: "RETRY_UPLOAD" }
  | { target: "background"; type: "RESET" }
  | { target: "background"; type: "GET_STATE" }
  | { target: "background"; type: "OFFSCREEN_STATE"; payload: Partial<RecState> };

/** Messages handled by the offscreen document. */
export type OffscreenMessage =
  | { target: "offscreen"; type: "OFFSCREEN_START"; payload: OffscreenStartPayload }
  | { target: "offscreen"; type: "OFFSCREEN_STOP" }
  | { target: "offscreen"; type: "OFFSCREEN_RETRY" }
  | { target: "offscreen"; type: "OFFSCREEN_DISCARD" };

/** Standard response envelope for hub messages. */
export interface Ack {
  ok: boolean;
  error?: string;
  state?: RecState;
}
