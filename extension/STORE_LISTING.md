# Chrome Web Store listing: Followthrough Recorder

Copy for the Chrome Web Store developer dashboard. Nothing here has been submitted. Build the upload with `bun run package` (in `extension/`), which writes `followthrough-recorder-<version>.zip` with `manifest.json` at the archive root.

## Store listing tab

**Name** (from `manifest.json`)

Followthrough Recorder

**Short description** (manifest `description` is what the store shows; max 132 characters)

> Records the current tab's audio and uploads it to Followthrough as a client meeting.

84 characters, matches `manifest.json`. If it is changed here, change the manifest too.

**Detailed description**

> Followthrough Recorder captures the audio of a call you are on in a browser tab (Google Meet, Zoom on the web, Teams on the web and similar) and sends it to your own Followthrough server, where it becomes a client meeting with a transcript and tracked follow-ups.
>
> How it works:
> 1. Open the tab with your call and click the extension icon.
> 2. Sign in to your Followthrough server with your email and login code. The server address is yours to set: a self-hosted install or your team's hosted one.
> 3. Pick the client, check the meeting title, and confirm that everyone on the call knows it is being recorded. Recording cannot start without that confirmation.
> 4. Press Start. The tab stays audible and you can close the popup; recording carries on in the background.
> 5. Press Stop and upload. The recording goes straight to your server and shows up in Followthrough under that client.
>
> What it does not do:
> - It records only the tab you start it on, only while you have it running, and only audio.
> - It sends the recording to the server address you entered and nowhere else. There is no third-party analytics, advertising or tracking.
> - It does not store your login code.
>
> You need a Followthrough account on a Followthrough server, issued by your admin, and at least one client set up in the web app.

**Category**

Productivity (subcategory: Workflow & Planning).

**Language**

English.

## Graphic assets

| Asset | Size | Status |
| --- | --- | --- |
| Store icon | 128x128 PNG | Ready: `icons/icon-128.png` (same file as the manifest icon). Google's guidance is 96x96 artwork inside 16px of transparent padding; this icon is a full-bleed dark square, so consider a padded variant for the listing. |
| Screenshots | 1280x800 (or 640x400) PNG or JPEG, 1 to 5 | To do. Suggested: the popup sign-in screen, the recorder form with the consent box, the popup mid-recording with the timer, and the resulting meeting in the Followthrough web app. |
| Small promo tile | 440x280 PNG or JPEG | To do. The dashboard asks for it on the listing page. |
| Marquee promo tile | 1400x560 | Optional. |

Manifest icons (`icons/icon-16.png`, `icon-48.png`, `icon-128.png`) are drawn from the site favicon mark by `bun run icons` (`make-icons.ts`): dark `#0A0B0D` square, thin `#272A2F` vertical line, amber `#F4A521` dot.

## Privacy practices tab

**Single purpose**

> Record the audio of the current browser tab when the user asks, and upload that recording to the user's own Followthrough server as a client meeting.

**Permission justifications**

| Permission | Justification |
| --- | --- |
| `tabCapture` | Captures the audio of the tab the user is on when they press Start recording. This is the extension's only function. Capture starts only from the user's click and stops when they press Stop. |
| `offscreen` | Manifest V3 service workers cannot run `MediaRecorder` or Web Audio. An offscreen document (reason `AUDIO_PLAYBACK`) records the captured stream and plays it back to the speakers so the call stays audible while it is recorded, then uploads the finished file. |
| `storage` | `chrome.storage.local` keeps the Followthrough server address and a signed-in flag with the user's email, user id and role so the popup opens in the right state. `chrome.storage.session` keeps the current recording state (recording, uploading, done) so the popup can be closed and reopened mid-recording. The login code is never stored. |
| `activeTab` | Gives the extension access to the tab the user is looking at when they click the toolbar icon, which is the tab whose audio `tabCapture` records. No other tabs are read. |
| Host permission `http://localhost:4500/*` | The default address of a local Followthrough server, so a self-hosted install works without an extra prompt. Used to sign in, list the user's clients and upload the recording. |
| Optional host permissions `https://*/*`, `http://*/*` | Followthrough is self-hosted, so the server address is different for every team and cannot be listed in advance. When the user saves their server address in the popup, the extension asks Chrome for permission on that one origin only (`chrome.permissions.request`), and uses it only to talk to that server. Nothing is requested until the user enters an address. |

**Remote code**

No. All JavaScript is bundled in the package; the extension does not load or evaluate code from anywhere else.

**Data usage** (what to tick on the form)

| Data type | Collected? | What and why |
| --- | --- | --- |
| Personally identifiable information | Yes | The user's email address, sent to their Followthrough server to sign in, and stored locally (with their user id and role) only while they are signed in. Signing out removes it. |
| Authentication information | Yes | The login code, sent once to the user's Followthrough server to sign in. Never stored by the extension. Afterwards the server's session cookie is used. |
| Website content | Yes | The audio of the tab the user chose to record, uploaded to the user's Followthrough server, with the client and meeting title they picked. |
| Personal communications | Yes | The recorded tab is usually a call, so the audio is communications content. Ticked to be safe; it goes only to the user's own server. |
| Health, financial, location, web history, user activity | No | Not collected by the extension. (A recorded call may mention such things; the audio goes only to the user's own server.) |

**Where the data goes**

Recordings, sign-in details and meeting details go only to the Followthrough server address the user entered (by default their own machine, `http://localhost:4500`). That server is run by the user or their organisation. The extension has no backend of its own and sends nothing to the extension's publisher or to any third party. Audio is held in memory until it is uploaded and is discarded after upload or when the user presses Discard.

**Certifications** (all true for this extension)

- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL**

https://followthrough-eight.vercel.app/privacy.html (required because the extension handles user data).
