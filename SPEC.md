# Followthrough: Product + Technical Spec (v1 / MVP)

Everything in this document is v1 scope by explicit decision of the founder ("do all in v1, I want this to be the MVP"). There is no v2 column. The build order section at the end sequences the work so the end-to-end loop works early, but all sections ship in the MVP.

Followthrough is a meeting-intelligence-to-action tool. It turns recorded client meetings into tracked, evidenced, closed-loop commitments: insight extracted, human-finalized, routed to a track, shipped with proof, client told, every timestamp measured.

---

## 1. Users and auth

- **Open by default** (as built): with **Require login** off, every visitor is an admin, which suits a laptop install. Turning it on (Settings, Access) enforces everything below.
- One **admin** (the founder). Admin adds users by email and issues a **login code**. Invite = send a link or hand over the code. An optional shared team password (`ACCESS_PASSWORD`) also exists.
- Login: email + code. Codes are stored hashed, are revocable and rotatable per user (offboarding someone who had access to client calls must be one click).
- Sessions: signed HTTP-only cookies.
- Rate limiting + lockout on the login endpoint (a static code is effectively a password to the whole client-call archive; brute force must be expensive).
- Roles: `admin`, `member`. Admin-only views enforced server-side, never just hidden in the UI.
- Every state change is attributed: who did it, when (this also feeds all TAT metrics).

## 2. The pipeline (canonical)

1. **Capture and upload.** Meeting recorded via the bundled Chrome extension or any external tool (Meet, Zoom, Fireflies). Any logged-in user uploads audio and/or transcript. A watched ingest folder (`WATCH_DIR`, a local directory) auto-picks up dropped recordings as pending meetings. Read-only Google Drive ingest is planned, not built (`drive` exists only as a meeting source label).
2. **Transcription.** If only audio arrives: local whisper.cpp (`scripts/setup-whisper.sh`, no key, audio stays on the machine) or Deepgram pre-recorded when `DEEPGRAM_API_KEY` is set; manual transcript paste always works. States: `uploaded -> transcribing -> transcribed | transcription_failed` with retry and a low-quality flag.
3. **Extraction.** Multi-pass LLM pipeline (section 5) produces typed insights and action items with verbatim transcript citations.
4. **Tag and route.** Track (engineering / marketing / product_polish / other), assignee, freeform tags. LLM proposes, human confirms.
5. **Human finalization.** A person reviews against the quoted transcript evidence, polishes wording, finalizes. Nothing auto-proceeds past this gate. Reject and merge paths exist.
6. **Ticketing (human-triggered only).** For engineering insights a person clicks "Raise ticket". The tool drafts the issue (with a hidden machine-readable insight-ID marker) and asks that person to choose: (a) create directly on GitHub in a repo they pick from the configured repo list, or (b) copy the text, create it by hand anywhere, then paste the issue URL back. **The tool never creates a GitHub issue on its own.** Hard org-safety allowlist: orgs listed in `BLOCKED_ORGS` (typically your own company's org) are blocked for writes in code until explicitly enabled by the admin.
7. **Release watching and matching.** A read-only poller mirrors the GitHub releases of a configured repo (`RELEASE_REPO`). Each new release is parsed into discrete entries and matched against open insights/tickets. Matches carry a confidence score (section 6) and sit as *proposed* until a human confirms. Confirmation creates completion evidence.
8. **Completion evidence (all tracks).** `shipped` requires one confirmed evidence record. Engineering: confirmed release match. Marketing: published-asset URL (system verifies it is live). Product-polish: release match when it shipped via code, else verified-in-product attestation with before/after screenshot. Manual attestation exists as the escape hatch.
9. **Client follow-up.** On shipped, the assignee generates an email draft (quotes the client's own words back, cites the changelog entry or asset URL, fans out one draft per requesting client). Copy-to-clipboard is logged as an event; a separate explicit "I sent it" confirmation closes the loop. No Gmail API in v1.
10. **Admin dashboard.** TAT per stage per track, funnel, WIP/aging, stuck items, per-person throughput, per-client closed-loop rate, theme demand, AI quality. All queries over the event log.
11. **CRM hand-off.** CSV export per client (and all-clients), shaped to Zoho CRM import format with stable IDs. Export events tracked. Direct Zoho integration later.

## 3. Clients and the meeting timeline

- **Client is a first-class entity** (name, domain, contacts with emails, optional CRM id). Every meeting belongs to a client (or is flagged `internal`).
- Meetings carry: client, date, auto-derived **sequence number per client** (meeting #1, #2, #3...), attendees, type (discovery / demo / QBR / support), source (extension / meet / zoom / fireflies / manual / watch-folder).
- **Client timeline view**: all meetings chronologically with their insights, plus a rollup of all open asks for that client.
- **Recurring asks attach, never duplicate**: a repeat request in meeting #3 of something raised in meeting #1 becomes a new *mention* on the existing insight. The insight shows every mention with meeting and date. Asked-again raises priority.
- **Cross-client canonical insights**: the same ask from different clients merges (human-confirmed) into one canonical insight carrying a requester list and a "requested by N clients" counter. The backlog sorts by it. When it ships, follow-up emails fan out to every requesting client.
- **Promise ledger + pre-call brief**: per client, every ask with status and evidence link, and a one-click markdown brief (open asks, shipped since last call, follow-ups owed).

## 4. Insight lifecycle (state machine)

States: `extracted -> triaged -> finalized -> ticketed -> shipped -> client_notified -> closed`, plus terminal `rejected` and `merged`.

- `extracted -> triaged`: track + assignee set.
- `triaged -> finalized`: human polished and signed off (records `finalized_by`). Original LLM text kept immutable alongside.
- `finalized -> ticketed`: engineering path; requires the ticket record to carry `raised_at` + the GitHub issue URL (pasted back or returned by direct-create).
- `finalized -> shipped`: tracks with no ticket step, on confirmed evidence.
- `ticketed -> shipped`: on confirmed evidence (normally a confirmed release match).
- `shipped -> client_notified`: first copy event on a follow-up draft.
- `client_notified -> closed`, `shipped -> closed` (skip-notify path, reason required).
- `* -> rejected` (reason required; finalized+ demotion is admin-only). `extracted/triaged -> merged` (target required).
- Admin-only `reopen` (`closed -> finalized`, reason required) is a compensating event; history is never edited. A post-finalization **revoke** that flags the linked GitHub issue and suppresses pending client email is planned, not built.
- Transitions validated against a single transition map in code; each transition = one event row + cached `state` column update in the same transaction.
- Mis-tagged insights re-route (track change preserved in history). Cross-track asks split into sibling insights sharing one source.
- Concurrency: per-insight version counter, stale-save conflict warning, soft "being edited by X" indicator.

## 5. Extraction pipeline and quality (the evals)

Pipeline per meeting:
1. **Clean and segment** the transcript (speaker turns, filler removal, overlap-chunking for long calls, coverage indicator so a truncated half is visible).
2. **Typed extraction**: each item is one of `feature_request | complaint | key_insight | action_item_ours | commitment_theirs | status_update`. Typed prompts, not "summarize".
3. **Grounding rule: no citation, no insight.** Every item carries the verbatim quote, speaker, and position. The quote is programmatically verified as a substring of the transcript. Hallucinated items die here.
4. **Verifier pass**: an independent LLM judge checks each candidate against its quote (really a request? right owner? right type?). Failures dropped or flagged low-confidence.
5. **Dedup/merge pass** against the client's open insights (FTS similarity shortlist + LLM confirm; suggestions only, human confirms merges).
6. Context-aware: extraction for meeting #N receives the client's open insights, so it distinguishes follow-ups from new asks and catches spoken status updates.
7. Re-extraction is additive and idempotent (extraction_runs provenance; never duplicates or resurrects finalized/rejected insights). Humans can manually add an insight the LLM missed; it enters the same state machine.

Eval harness (in-repo, runs on every prompt change):
- **Golden set**: 4 hand-written fictional transcripts (a normal call, a no-asks call that tests abstention, a Hinglish call, and a call containing a prompt-injection line) with author-labeled expected outputs in `evals/golden/`. Teams add their own cases with `evals/draft-golden.ts`.
- Scored on recall (missed asks), precision (invented items), citation validity (exact check) and type accuracy. One LLM-judge call per case matches predicted items to labels; citation checks are exact. Owner accuracy is not scored yet. Run by hand with `bun run evals` (needs an LLM key; CI does not run it).
- **The flywheel**: finalization is a labeling machine. Every human edit (draft vs final text), every discard with reason, is captured automatically. Discards become regression cases; edit distance and discard rate are the live quality gauges.

LLM policy: Anthropic API direct is preferred. As built, OpenRouter is accepted as a fallback only when pinned to Anthropic Claude models with `data_collection: deny`; no other vendor is used. Model configurable via `LLM_MODEL` (default `claude-opus-4-8`) with adaptive thinking. Structured outputs via Zod, SDK retries, per-call cost logging, and a hard daily spend cap (`LLM_DAILY_BUDGET_USD`).

## 6. Changelog matching and the confidence score

- Poller (hourly) mirrors the configured GitHub repo's releases read-only into a local table. Matching runs per release and TAT anchors to the FIRST release containing a change.
- Parser: normalize body, split H2 sections (fuzzy header vocabulary), each H3 = one entry; technical-details blocks parsed separately; PR refs (#N) are format-validated only, not yet checked against GitHub; gating/revert language detected ("flag-gated", "internal admin app", "shadow", "reverted by #N"). When the deterministic parse yields zero entries, the whole body becomes one `baseline` entry (no LLM parser). Golden-file tests use fictional release bodies that cover the format quirks (v1.20.0, v1.19.2, the indented v1.18.0, single-entry v1.17.4, baseline v1.0.0, the large mixed v1.16.0).
- Matching: LLM semantic match is the primary v1 path (ticket PR-ref matching mostly cannot fire until tickets live in the product's own org; the insight-ID marker makes that future migration an exact join). Judge returns full/partial/none with verbatim evidence quotes, programmatically verified as substrings of the entry.
- Confidence (as built, `confidenceFor` in `src/releases/matcher.ts`): 100 = human clicked confirm (the only way to 100). 80 = judge says full match. 60 = cap for an entry from the technical-details section. 50 = partial match, or any match capped because the entry is flag-gated, internal-only, shadow, advisory or reverted (products often ship dark; a gated entry must never trigger a "your feature shipped" email). A 90 tier for deterministic PR/tag evidence is planned for after tickets live in the product's own org.
- Every score displays its evidence chain: release tag, date, quoted entry, rationale. Proposed matches sit in the assignee's confirm queue.

## 7. Ticketing rules (org safety)

- Draft-first, human-triggered, per-ticket choice (direct-create in a chosen repo, or copy + paste-back URL). No automatic creation, ever.
- Config-level writable-repo allowlist enforced in code; blocked orgs excluded until the admin flips it. The GitHub token for release reading is read-only scope.
- Every draft embeds `<!-- followthrough:INS-<id> -->` plus a visible footer link. Stable internal IDs survive the eventual repo/org migration.
- Stale state for "draft generated but never confirmed created".

## 8. Follow-up emails

- Drafts grounded in: the finalized insight, the client's verbatim quote and call date, the confirmed evidence (changelog entry / asset URL), and the ask-to-ship duration when flattering.
- Fan-out: one draft per requesting client on canonical insights.
- Copy button logs an `email.copied` event (actor, draft, timestamp). Separate explicit "I sent it" confirmation (optional paste-back of the edited final text). Copies with no sent-confirmation after N days surface as stale.
- Brand voice per DESIGN.md: direct, no fluff, no em-dashes, no banned words.

## 9. Storage and files

- SQLite (WAL mode) for all metadata + transcripts. Audio/video/screenshots/CSVs are blobs behind a `media_assets` abstraction: `storage_backend` + relative `storage_ref` + `sha256`. v1 backend = local disk volume; S3 later is a per-row backend flip after hash-verified copy. Google Drive is read-only ingest only, never a write backend.
- Content-addressed dedup by sha256 (same recording uploaded twice attaches to the existing meeting; retried uploads are idempotent).
- Upload status per file (uploading/uploaded/failed) with retry.
- **Backups are in scope**: nightly SQLite backup + blob sync script with retention; documented restore.

## 10. Privacy, consent, retention

- Consent-confirmed checkbox at upload blocks processing until checked.
- Deletion path: purge a meeting's audio, transcript, and derived quotes on request; insights survive anonymized unless also purged.
- Raw recordings are not browsable by everyone: meeting-level access defaults to all members, but the admin can restrict a meeting to named users.
- Client transcripts go only to the configured LLM provider (Anthropic direct, or OpenRouter pinned to Claude with data collection denied) and the configured STT provider (local whisper.cpp or Deepgram).

## 11. Metrics (admin dashboard)

All derived from the append-only `events` table; status columns are caches, never sources.

- **Stage TATs** (mean/median/p90, per track, per week): extracted->finalized, finalized->ticketed (engineering's "went to engg"), ticketed->shipped (anchored to the human-confirmed evidence event; release published_at stored as display metadata), shipped->client_notified (the founder's "changelog to email copied" gap), plus end-to-end captured->notified.
- **Funnel**: % of insights reaching finalized / actioned / shipped / notified per cohort, per track, with drop-off.
- **WIP and aging**: open insights per stage with age buckets; **stuck-item list** over per-stage thresholds shown red on the dashboard and in the digest.
- **People**: per-person throughput (finalized / actioned / closed per week) and open load.
- **Clients**: per-client closed-loop rate, coverage (meetings but zero insights, gone-dark accounts), open commitments with age.
- **Demand**: tag/theme frequency with trend; theme breadth (distinct clients per theme, separating one loud client from broad demand); department mix.
- **AI quality**: discard rate, edit-distance ratio (draft vs final snapshots captured from day one), routing-correction rate, changelog-match precision, extraction yield per meeting.
- **Volume**: capture volume by source/uploader (top-of-funnel health), tickets/ships/notifies per week, CRM export activity.

Event taxonomy (35 namespaced types in code as of 2026-10-14, including `meeting.uploaded`, `extraction.completed/failed`, `insight.state_changed/routed/absorbed_merge/body_edited`, `ticket.drafted/raised`, `release.fetched`, `match.proposed/confirmed`, `evidence.confirmed`, `email.drafted/copied/sent_confirmed`, `export.csv_generated`, `user.created`) with a common envelope (actor, entity, occurred_at, payload). SQLite triggers make the table physically append-only. One `insight_milestones` view (MIN occurred_at per state) makes every TAT a simple SELECT.

## 12. Notifications, queues, digest, search

- **My queue** per user: items awaiting my action at every stage (review, finalize, ticket, confirm match, send email).
- In-app assignment notifications; stale-work nudges per stage.
- **Weekly admin digest** (cron): new insights by track, awaiting finalization, no-state-change > X days, completions with evidence, top canonical insights by requester count, shipped-but-not-emailed. In-app rendering + optional webhook (Slack/Google Chat). No SMTP and no Gmail API.
- **Search**: SQLite FTS5 across transcripts, insights, quotes, ticket drafts, email drafts; filters for client/track/status/date; results deep-link to the transcript position.

## 13. CSV / CRM export

- Zoho-import-shaped columns (Account/Contact lookup keys, Note title/content), one row per insight per client, stable canonical-insight IDs and status so repeated imports dedupe.
- Per-client and all-clients variants. Rejected/revoked excluded by default.
- Export events tracked (rows, version, who, when) with "changed since last export" on re-export. This bookkeeping becomes the Zoho sync cursor later.

## 14. Chrome extension capture

- Reuses the ClientLens MV3 capture chain (tabCapture -> offscreen document -> AudioWorklet) **plus a new MediaRecorder branch** that persists webm/opus and uploads to Followthrough with the user's session.
- Built last in the build order; the upload API accepts files from any tool from day one, so the extension is an additional source, not a dependency.

## 15. Stack (one runtime, one source of truth)

- **Bun + TypeScript** end to end. Server: `Bun.serve` (content-engine pattern). DB: `bun:sqlite`. Frontend: React + Vite, custom CSS implementing DESIGN.md tokens (product register). Validation: Zod at every boundary. Tests: `bun test`, golden-file tests for parsers, eval harness for prompts.
- LLM: Anthropic API direct with retry/structured outputs/cost-logging (lifted from content-engine `engine/providers/`), OpenRouter fallback pinned to Claude. STT: local whisper.cpp or Deepgram pre-recorded.
- No embeddings/vector store in v1: FTS + LLM judge covers matching and merge suggestions at this scale.
- Reuse map: content-engine (LLM provider layer, judge+heal-loop rubric, approval-gate pattern, manual-copy timestamp ledger pattern, state-machine shape, hash idempotency, atomic writes, release-poller shape, CSV writers). Sales extension (post-call summary agent as extraction seed, extractJson/safeJson, upload hardening, email council staging, auth middleware shape, capture chain). Patterns ported to this stack; no Python, no Supabase, no file-based state store. (OpenRouter was originally excluded; it was later added as a Claude-only fallback.)

## 16. UI (DESIGN.md, product register)

- As built: the "Transcript Spine" system in DESIGN.md. Dark-only, one signal-amber accent (`#f4a521`), Inter for UI, Newsreader serif for headers, JetBrains Mono for labels and numbers; tokens in `web/src/styles.css`. (The original plan here, Space Grotesk with an orange accent and a light/dark toggle, was replaced.)
- Tables use mono headers and tabular-nums right-aligned numerics; empty/loading/error states use skeletons, no shimmer, and factual error copy; modals only for destructive confirms.
- No em-dashes in any UI copy. No banned words. Mobile breakpoints tested at 375/768/1024/1440.

## 17. Security posture

- Login rate-limiting + lockout; hashed codes; revocation; session expiry.
- Server-side authz on every route; admin views enforced server-side.
- GitHub: read-only token for releases; write allowlist excluding blocked orgs until enabled; tokens server-side only (never shipped to the browser or extension).
- Upload hardening: size caps, filename sanitization, content-type branching (no decoding audio as text).
- Append-only audit log (the events table) for every state change.
- TLS required at deployment; backups per section 9.

## 18. Build order (all v1; sequenced for an early working loop)

1. **Core skeleton**: schema + events + state machine, auth, server, design tokens.
2. **Walking skeleton loop**: upload transcript -> extract -> review/finalize -> ticket draft + URL paste-back -> manual mark-shipped with evidence -> email draft + copy event -> minimal TAT dashboard. (First real meeting flows end to end here.)
3. **Matching engine**: release poller + parser + golden tests, LLM matcher, confirm queue, confidence scores.
4. **Clients deepened**: timeline, mentions, canonical merge + fan-out, promise ledger, pre-call brief.
5. **Quality**: eval harness + golden set, verifier pass tuning, edit-distance capture.
6. **Visibility**: full metrics dashboard, my-queue, nudges, digest, search.
7. **Ingest breadth**: STT, watch-folder, consent/retention, CSV export. (Drive read-only ingest: planned, not built.)
8. **Extension capture** + direct-create ticketing + backups/deploy hardening.

## 19. Decisions log

- All-in-v1 MVP (founder, 2026-06-10). No phasing of scope, only sequencing.
- Tickets: human-triggered only; per-ticket choice of direct-create (repo picked by the human from a configured list) vs copy-paste with URL paste-back. No auto-creation. Blocked orgs write-blocked until enabled. (founder, 2026-06-10)
- Changelog source: GitHub releases on the configured repo, read-only. (founder)
- Email: draft + copy-to-clipboard with logged timestamp; explicit sent-confirmation; no Gmail API. (founder)
- CRM: CSV for now, Zoho-shaped; direct integration later. (founder)
- Storage: local disk now (Drive read-only ingest only), S3 after deployment. (founder + critic)
- Auth: admin + email/login-code. (founder)
- Stack: Bun + TypeScript + SQLite + React, Anthropic direct. (critic-driven consolidation)
- Design: see `DESIGN.md` and `design-reference/` (design system), product register.
