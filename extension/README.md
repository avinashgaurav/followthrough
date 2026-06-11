# Insights Engine Recorder (Chrome extension)

A minimal Chrome MV3 extension that records the audio of the current tab and uploads it to Insights Engine as a client meeting. The tab stays audible while recording (the captured stream is routed back to the speakers through an AudioContext gain node).

## Assumptions

- The Insights Engine server is running at **http://localhost:4500** (`bun run dev` at the repo root). The base URL lives in a single constant in `src/config.ts`; when the app deploys, change `BASE_URL` there AND the `host_permissions` entry in `manifest.json`, then rebuild.
- You have a login (email + login code) issued by the admin in the web app.
- At least one client exists in the web app (the popup's client dropdown is loaded from `GET /api/clients`).

## Install

```sh
cd extension
bun run build        # bundles src/ and copies static files into extension/dist
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/dist` directory.

After changing source files, run `bun run build` again and press the reload icon on the extension card.

Optional: `bun run typecheck` runs `tsc` over `src/` (strict mode, no emit).

## Use

1. Open the tab you want to record (the meeting tab: Meet, Zoom web, etc.).
2. Click the extension icon. Log in with your email and login code the first time. Only a logged-in flag is stored locally; the code is never persisted.
3. Pick the client, adjust the meeting title, and tick the consent checkbox ("Everyone on this call has been informed it is recorded"). The checkbox is required; recording cannot start without it.
4. Press **Start recording**. The popup shows an elapsed timer. You can close the popup; the recording continues in the background. The tab remains audible.
5. Press **Stop and upload**. The recording is sent to `POST /api/meetings` as `meeting-<timestamp>.webm` with source `extension` and today's date.
6. On success the popup shows the meeting id and a link to the web app (`/capture`). If the exact same recording was uploaded before, the server reports it as a duplicate and the popup says so; nothing is duplicated.

If an upload fails (server down, session expired), the recording is kept in memory and the popup offers **Retry upload**. Log back in first if the session expired. **Discard** abandons the recording.

## How it works

- **Popup** (`src/popup.ts`): login view + recorder form. Talks to the service worker through `chrome.runtime.sendMessage` and polls recording state while active.
- **Service worker** (`src/background.ts`): single `onMessage` hub (only ONE listener may exist in the SW; Chrome closes the response channel when any listener returns a falsy value, so a second listener never gets `sendResponse`). Resolves the tabCapture `streamId` for the active tab, manages the offscreen document, and persists recording state in `chrome.storage.session`.
- **Offscreen document** (`src/offscreen.ts`, reason `AUDIO_PLAYBACK`): runs `getUserMedia` with `chromeMediaSource: "tab"`, records with `MediaRecorder` (`audio/webm;codecs=opus`), routes the stream through a gain node so the tab is not muted, and uploads the finished blob directly with `fetch(..., { credentials: "include" })`.

All requests use the session cookie (`credentials: "include"`). The `host_permissions` grant for `http://localhost:4500/*` is what lets extension pages send that cookie and skip CORS; this is why `BASE_URL` and `host_permissions` must always match.

## Limitations

- Chrome cannot capture `chrome://` pages or the Chrome Web Store.
- One recording at a time.
- The recording is held in memory until uploaded; quitting Chrome before upload loses it.
