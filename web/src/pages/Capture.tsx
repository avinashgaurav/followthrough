import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  ApiError,
  MEETING_SOURCES,
  MEETING_TYPES,
  type CalendarEvent,
  type Client,
  type Meeting,
} from "../api";
import {
  Alert,
  Btn,
  Combobox,
  EmptyState,
  ErrorAlert,
  Field,
  Markdown,
  SectionHead,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import { ageOf, formatDate, formatDateTime, titleCase } from "../format";

// ============================================================ helpers (local to this page)

/** Today's date as a yyyy-mm-dd string for a date input default. */
function todayISO(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Calendar start ISO -> the yyyy-mm-dd a date input wants. Falls back to today. */
function dateInputFromIso(iso: string | undefined): string {
  if (!iso) return todayISO();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return todayISO();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function meetingSeq(m: Meeting): number | undefined {
  if (typeof m.seq === "number") return m.seq;
  if (typeof m.seq_no === "number") return m.seq_no;
  return undefined;
}

function attendeeNames(ev: CalendarEvent): string[] {
  return (ev.attendees ?? [])
    .map((a) => (a?.name || a?.email || "").trim())
    .filter(Boolean);
}

/** What the multipart upload tab is feeding the meeting. */
type InputMode = "paste" | "transcript_file" | "audio_file";
type Path = "calendar" | "manual";

// ============================================================ Capture

export function Capture() {
  const navigate = useNavigate();
  const toast = useToast();

  // ---- which intake path
  const [path, setPath] = useState<Path>("manual");

  // ---- reference data
  const [clients, setClients] = useState<Client[]>([]);
  const [clientsError, setClientsError] = useState<unknown>(null);
  const [calConfigured, setCalConfigured] = useState<boolean | null>(null);
  const [sttOk, setSttOk] = useState<boolean>(false);

  // ---- the form
  const [client, setClient] = useState<Client | null>(null);
  const [meetingDate, setMeetingDate] = useState<string>(todayISO());
  const [title, setTitle] = useState("");
  const [meetingType, setMeetingType] = useState<string>(MEETING_TYPES[0]);
  const [source, setSource] = useState<string>("manual");
  const [consent, setConsent] = useState(false);
  const [attendeesJson, setAttendeesJson] = useState<string | null>(null);
  const [pickedUid, setPickedUid] = useState<string | null>(null);

  // ---- conversation input
  const [inputMode, setInputMode] = useState<InputMode>("paste");
  const [transcriptText, setTranscriptText] = useState("");
  const [transcriptFile, setTranscriptFile] = useState<File | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);

  // ---- submission + result
  const [submitting, setSubmitting] = useState(false);
  const [createdMeeting, setCreatedMeeting] = useState<Meeting | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ---- post-create actions
  const [extracting, setExtracting] = useState(false);
  const [extractSummary, setExtractSummary] = useState<{
    created?: number;
    dropped?: number;
    analysisMd?: string;
  } | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [hadAudioOnly, setHadAudioOnly] = useState(false);

  const transcriptFileRef = useRef<HTMLInputElement>(null);
  const audioFileRef = useRef<HTMLInputElement>(null);

  // ---- recent meetings list
  const [recent, setRecent] = useState<Meeting[] | null>(null);
  const [recentError, setRecentError] = useState<unknown>(null);

  const loadClients = useCallback(async () => {
    setClientsError(null);
    try {
      setClients(await api.listClients());
    } catch (e) {
      setClientsError(e);
    }
  }, []);

  const loadRecent = useCallback(async () => {
    setRecentError(null);
    try {
      setRecent(await api.listMeetings());
    } catch (e) {
      setRecentError(e);
      setRecent([]);
    }
  }, []);

  useEffect(() => {
    void loadClients();
    void loadRecent();
    api
      .calendarStatus()
      .then((r) => setCalConfigured(!!r?.configured))
      .catch(() => setCalConfigured(false));
    api
      .sttStatus()
      .then((r) => setSttOk(!!(r?.ok ?? r?.available ?? r?.enabled)))
      .catch(() => setSttOk(false));
  }, [loadClients, loadRecent]);

  const clientMeetingCount = useCallback((c: Client): number | undefined => {
    const v = c.meetings_count ?? c.meeting_count;
    return typeof v === "number" ? v : undefined;
  }, []);

  const onCreateClient = useCallback(
    async (name: string) => {
      const cleaned = name.trim();
      if (!cleaned) return;
      try {
        const res = await api.createClient({ name: cleaned });
        const newClient: Client =
          (res?.client as Client | undefined) ??
          ({ id: String(res?.id ?? ""), name: cleaned } as Client);
        if (!newClient.id) {
          // Fall back to a fresh list lookup if the id did not come back inline.
          const list = await api.listClients();
          setClients(list);
          const match = list.find((c) => c.name === cleaned);
          if (match) setClient(match);
        } else {
          setClients((prev) => [newClient, ...prev]);
          setClient(newClient);
        }
        toast.push(`Added client "${cleaned}".`, "success");
      } catch (e) {
        toast.push(
          e instanceof ApiError ? e.message : "Could not add that client.",
          "critical",
        );
      }
    },
    [toast],
  );

  // Pick a calendar event -> prefill the form fields.
  const pickEvent = useCallback(
    (ev: CalendarEvent) => {
      setPickedUid(ev.uid ?? null);
      if (ev.title) setTitle(ev.title);
      setMeetingDate(dateInputFromIso(ev.start));
      const names = attendeeNames(ev);
      setAttendeesJson(names.length ? JSON.stringify(names) : null);
      setSource((prev) => (prev === "manual" ? "meet" : prev));
      // Pre-select the suggested client when we can find it.
      if (ev.suggested_client_id) {
        const match = clients.find((c) => c.id === ev.suggested_client_id);
        if (match) setClient(match);
      } else if (ev.suggested_client_name) {
        const match = clients.find(
          (c) => c.name.toLowerCase() === ev.suggested_client_name!.toLowerCase(),
        );
        if (match) setClient(match);
      }
    },
    [clients],
  );

  const conversationProvided =
    (inputMode === "paste" && transcriptText.trim().length > 0) ||
    (inputMode === "transcript_file" && !!transcriptFile) ||
    (inputMode === "audio_file" && !!audioFile);

  const canSubmit = !!client && !!meetingDate && consent && !submitting;

  const resetResult = useCallback(() => {
    setCreatedMeeting(null);
    setDuplicate(false);
    setCreateError(null);
    setExtractSummary(null);
    setHadAudioOnly(false);
  }, []);

  const onSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!client) {
        setCreateError("Pick a client first.");
        return;
      }
      if (!consent) {
        setCreateError("Confirm consent before adding the meeting.");
        return;
      }
      setSubmitting(true);
      setCreateError(null);
      const form = new FormData();
      form.set("client_id", client.id);
      form.set("meeting_date", meetingDate);
      if (title.trim()) form.set("title", title.trim());
      form.set("meeting_type", meetingType);
      form.set("source", source);
      form.set("consent_confirmed", "true");
      if (attendeesJson) form.set("attendees_json", attendeesJson);
      if (inputMode === "paste" && transcriptText.trim()) {
        form.set("transcript_text", transcriptText);
      } else if (inputMode === "transcript_file" && transcriptFile) {
        form.set("transcript_file", transcriptFile);
      } else if (inputMode === "audio_file" && audioFile) {
        form.set("audio_file", audioFile);
      }
      const audioOnly = inputMode === "audio_file" && !!audioFile;
      try {
        const res = await api.createMeeting(form);
        const meeting: Meeting | null =
          (res?.meeting as Meeting | undefined) ??
          (res?.id ? ({ id: String(res.id) } as Meeting) : null);
        if (!meeting?.id) {
          setCreateError("The meeting was created but no id came back. Check Review.");
          return;
        }
        setCreatedMeeting(meeting);
        setDuplicate(!!res?.duplicate);
        setHadAudioOnly(audioOnly && !res?.duplicate);
        if (res?.duplicate) {
          toast.push("That meeting was already in the system.", "info");
        } else {
          toast.push("Meeting added.", "success");
        }
        void loadRecent();
      } catch (err) {
        setCreateError(
          err instanceof ApiError ? err.message : "Could not add the meeting. Try again.",
        );
      } finally {
        setSubmitting(false);
      }
    },
    [
      client,
      consent,
      meetingDate,
      title,
      meetingType,
      source,
      attendeesJson,
      inputMode,
      transcriptText,
      transcriptFile,
      audioFile,
      toast,
      loadRecent,
    ],
  );

  const onExtract = useCallback(async () => {
    if (!createdMeeting?.id) return;
    setExtracting(true);
    try {
      const res = await api.extract(createdMeeting.id);
      const created = typeof res?.created === "number" ? res.created : undefined;
      const dropped = typeof res?.dropped === "number" ? res.dropped : undefined;
      const analysisMd =
        typeof res?.analysis_md === "string"
          ? res.analysis_md
          : typeof res?.markdown === "string"
            ? res.markdown
            : undefined;
      setExtractSummary({ created, dropped, analysisMd });
      toast.push(
        created !== undefined
          ? `Found ${created} ${created === 1 ? "ask" : "asks"} in this meeting.`
          : "Insights extracted.",
        "success",
      );
    } catch (err) {
      toast.push(
        err instanceof ApiError ? err.message : "Could not read this meeting. Try again.",
        "critical",
      );
    } finally {
      setExtracting(false);
    }
  }, [createdMeeting, toast]);

  const onTranscribe = useCallback(async () => {
    if (!createdMeeting?.id) return;
    setTranscribing(true);
    try {
      await api.transcribe(createdMeeting.id);
      toast.push("Audio turned into text. You can extract insights now.", "success");
      setHadAudioOnly(false);
    } catch (err) {
      toast.push(
        err instanceof ApiError ? err.message : "Could not transcribe the audio. Try again.",
        "critical",
      );
    } finally {
      setTranscribing(false);
    }
  }, [createdMeeting, toast]);

  const startAnother = useCallback(() => {
    resetResult();
    setClient(null);
    setTitle("");
    setMeetingType(MEETING_TYPES[0]);
    setSource("manual");
    setConsent(false);
    setMeetingDate(todayISO());
    setAttendeesJson(null);
    setPickedUid(null);
    setTranscriptText("");
    setTranscriptFile(null);
    setAudioFile(null);
    if (transcriptFileRef.current) transcriptFileRef.current.value = "";
    if (audioFileRef.current) audioFileRef.current.value = "";
    setInputMode("paste");
  }, [resetResult]);

  // ============================================================ render: success screen
  if (createdMeeting) {
    return (
      <>
        <SectionHead
          title="Capture"
          job="Get a meeting into the system."
          actions={
            <Btn
              variant="ghost"
              onClick={startAnother}
              tooltip="Clear this and start a fresh meeting."
            >
              Add another
            </Btn>
          }
        />
        <div className="page-body stack">
          {duplicate ? (
            <Alert severity="info" title="This meeting was already here.">
              <p style={{ margin: "0 0 8px" }}>
                We matched it to one already in the system, so nothing was duplicated.
              </p>
              <div className="row">
                <Btn
                  size="sm"
                  variant="primary"
                  onClick={() => navigate("/")}
                  tooltip="Open Review to work on this meeting's insights."
                >
                  Go to Review
                </Btn>
              </div>
            </Alert>
          ) : (
            <Alert severity="success" title="Meeting added.">
              <p style={{ margin: 0 }}>
                {client?.name ? `${client.name}. ` : ""}
                {formatDate(meetingDate)}. Now turn it into insights.
              </p>
            </Alert>
          )}

          <div className="card corner">
            <div className="lbl" style={{ marginBottom: 8 }}>
              Next step
            </div>

            {hadAudioOnly && sttOk && (
              <div className="stack-sm" style={{ marginBottom: 16 }}>
                <p className="small muted" style={{ margin: 0 }}>
                  You uploaded audio. Turn it into text first, then read it for insights.
                </p>
                <div className="row">
                  <Btn
                    onClick={onTranscribe}
                    disabled={transcribing}
                    tooltip="Run speech to text on the audio. After this you can extract insights."
                    tooltipTitle="Transcribe audio first"
                  >
                    {transcribing ? "Transcribing" : "Transcribe audio first"}
                  </Btn>
                </div>
                <hr className="divider" style={{ margin: "12px 0" }} />
              </div>
            )}

            <div className="row">
              <Btn
                variant="primary"
                onClick={onExtract}
                disabled={extracting}
                tooltip="Read the conversation and pull out asks, complaints, and insights. They land in Review for you to check."
                tooltipTitle="Extract insights now"
              >
                {extracting ? "Reading the meeting" : "Extract insights now"}
              </Btn>
              <Btn
                variant="ghost"
                onClick={() => navigate("/")}
                tooltip="Open Review to see and polish insights from this meeting."
              >
                Go to Review
              </Btn>
            </div>

            {extracting && (
              <div style={{ marginTop: 16 }}>
                <p className="small muted" style={{ margin: "0 0 8px" }}>
                  Reading the conversation. This can take a moment.
                </p>
                <Skeleton rows={3} />
              </div>
            )}

            {extractSummary && (
              <div style={{ marginTop: 16 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  {extractSummary.created !== undefined && (
                    <span className="small">
                      <b>{extractSummary.created}</b>{" "}
                      {extractSummary.created === 1 ? "insight" : "insights"} found.
                    </span>
                  )}
                  {extractSummary.dropped !== undefined && extractSummary.dropped > 0 && (
                    <span className="small muted">
                      {extractSummary.dropped} low-signal{" "}
                      {extractSummary.dropped === 1 ? "line" : "lines"} skipped.
                    </span>
                  )}
                  <Btn
                    size="sm"
                    variant="primary"
                    onClick={() => navigate("/")}
                    tooltip="Open Review to route and finalize these insights."
                  >
                    Review them
                  </Btn>
                </div>
                {extractSummary.analysisMd && (
                  <>
                    <div className="lbl" style={{ margin: "16px 0 7px" }}>
                      Meeting brief
                    </div>
                    <div className="bodybox" style={{ maxWidth: "none" }}>
                      <Markdown text={extractSummary.analysisMd} />
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </>
    );
  }

  // ============================================================ render: capture form
  const calReady = calConfigured === true;

  return (
    <>
      <SectionHead title="Capture" job="Get a meeting into the system." />
      <div className="page-body stack">
        {/* path picker */}
        <div>
          <div className="lbl" style={{ marginBottom: 7 }}>
            How do you want to add it
          </div>
          <div className="row" role="tablist" aria-label="Intake path">
            <Tooltip
              content={
                calReady
                  ? "Pick a meeting from your calendar feed. We fill in the title, date, and people for you."
                  : "Connect a calendar feed in Settings to use this."
              }
              title="From calendar"
            >
              <button
                type="button"
                role="tab"
                aria-selected={path === "calendar"}
                className={`btn ${path === "calendar" ? "primary" : "ghost"}`}
                disabled={!calReady}
                onClick={() => setPath("calendar")}
              >
                From calendar
              </button>
            </Tooltip>
            <Tooltip
              content="Type the details in yourself and paste or upload the conversation."
              title="Manual"
            >
              <button
                type="button"
                role="tab"
                aria-selected={path === "manual"}
                className={`btn ${path === "manual" ? "primary" : "ghost"}`}
                onClick={() => setPath("manual")}
              >
                Manual
              </button>
            </Tooltip>
          </div>
          {calConfigured === false && (
            <p className="helper" style={{ marginTop: 8 }}>
              No calendar feed connected yet.{" "}
              <Link to="/settings" style={{ color: "var(--accent-soft)", textDecoration: "underline" }}>
                Connect one in Settings
              </Link>{" "}
              to pick meetings straight from your calendar.
            </p>
          )}
        </div>

        {/* calendar event list */}
        {path === "calendar" && calReady && (
          <CalendarEventList
            onPick={pickEvent}
            pickedUid={pickedUid}
            clients={clients}
          />
        )}

        {!!clientsError && (
          <ErrorAlert error={clientsError} onRetry={() => void loadClients()} />
        )}

        {/* the form */}
        <form className="card stack" onSubmit={onSubmit} style={{ maxWidth: 720 }}>
          {pickedUid && (
            <Alert severity="info" title="Prefilled from your calendar.">
              <p style={{ margin: 0 }}>
                Check the details below, then add the conversation and confirm consent.
              </p>
            </Alert>
          )}

          <Field
            label="Client"
            htmlFor="cap-client"
            help="Who the meeting was with. Start typing to find them, or create a new client."
            hint={
              client && clientMeetingCount(client) !== undefined
                ? `This will be meeting ${(clientMeetingCount(client) ?? 0) + 1} with ${client.name}.`
                : "Pick an existing client or create a new one."
            }
          >
            <Combobox<Client>
              id="cap-client"
              items={clients}
              value={client}
              onChange={setClient}
              getKey={(c) => c.id}
              getLabel={(c) => c.name}
              onCreateNew={onCreateClient}
              placeholder="Search clients"
              renderItem={(c) => {
                const n = clientMeetingCount(c);
                return (
                  <span className="row-between" style={{ width: "100%" }}>
                    <span>{c.name}</span>
                    {n !== undefined && (
                      <span className="tiny subtle mono">
                        {n} {n === 1 ? "meeting" : "meetings"}
                      </span>
                    )}
                  </span>
                );
              }}
            />
          </Field>

          <div className="grid-2">
            <Field
              label="Meeting date"
              htmlFor="cap-date"
              hint="Defaults to today."
            >
              <input
                id="cap-date"
                type="date"
                className="ctrl"
                value={meetingDate}
                max={todayISO()}
                onChange={(e) => setMeetingDate(e.target.value)}
              />
            </Field>
            <Field
              label="Title"
              htmlFor="cap-title"
              hint="Optional. A short name helps you find it later."
            >
              <input
                id="cap-title"
                className="ctrl"
                value={title}
                placeholder="e.g. Q2 cost review"
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
          </div>

          <div className="grid-2">
            <Field
              label="Meeting type"
              htmlFor="cap-type"
              help="What kind of meeting this was. Helps group things later."
            >
              <select
                id="cap-type"
                className="ctrl"
                value={meetingType}
                onChange={(e) => setMeetingType(e.target.value)}
              >
                {MEETING_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {titleCase(t)}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Source"
              htmlFor="cap-source"
              help="Where the conversation came from. Leave as Manual if you are pasting it yourself."
            >
              <select
                id="cap-source"
                className="ctrl"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              >
                {MEETING_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {titleCase(s)}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {/* conversation input tabs */}
          <div className="field">
            <span className="lbl">The conversation</span>
            <div className="row" role="tablist" aria-label="Conversation input" style={{ marginBottom: 8 }}>
              <ConvTab
                active={inputMode === "paste"}
                onClick={() => setInputMode("paste")}
                tip="Paste the text of the conversation."
              >
                Paste transcript
              </ConvTab>
              <ConvTab
                active={inputMode === "transcript_file"}
                onClick={() => setInputMode("transcript_file")}
                tip="Upload a text file of the transcript."
              >
                Upload transcript file
              </ConvTab>
              <ConvTab
                active={inputMode === "audio_file"}
                onClick={() => setInputMode("audio_file")}
                tip={
                  sttOk
                    ? "Upload an audio recording. You can turn it into text after the meeting is added."
                    : "Upload an audio recording. Speech to text is not set up, so you will add the text yourself later."
                }
              >
                Upload audio file
              </ConvTab>
            </div>

            {inputMode === "paste" && (
              <textarea
                className="ctrl"
                value={transcriptText}
                placeholder="Paste the full transcript here. You can also add it later."
                rows={7}
                onChange={(e) => setTranscriptText(e.target.value)}
              />
            )}

            {inputMode === "transcript_file" && (
              <div className="stack-sm">
                <input
                  ref={transcriptFileRef}
                  type="file"
                  className="ctrl"
                  accept=".txt,.md,.vtt,.srt,text/plain"
                  onChange={(e) => setTranscriptFile(e.target.files?.[0] ?? null)}
                />
                {transcriptFile && (
                  <p className="helper">Selected: {transcriptFile.name}</p>
                )}
              </div>
            )}

            {inputMode === "audio_file" && (
              <div className="stack-sm">
                <input
                  ref={audioFileRef}
                  type="file"
                  className="ctrl"
                  accept="audio/*,.m4a,.mp3,.wav,.mp4"
                  onChange={(e) => setAudioFile(e.target.files?.[0] ?? null)}
                />
                {audioFile && <p className="helper">Selected: {audioFile.name}</p>}
                <p className="helper">
                  {sttOk
                    ? "After the meeting is added, turn the audio into text, then extract insights."
                    : "Speech to text is not set up. Add the text in Review once the meeting is in."}
                </p>
              </div>
            )}

            {!conversationProvided && (
              <p className="helper" style={{ marginTop: 6 }}>
                You can add the conversation now or later. Either way the meeting gets created.
              </p>
            )}
          </div>

          {/* consent */}
          <div className="field">
            <Tooltip
              title="Why this is required"
              content="We only process meetings everyone agreed to record. Confirming this keeps you on the right side of consent rules."
            >
              <label className="checkrow" htmlFor="cap-consent">
                <input
                  id="cap-consent"
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  Everyone on the call was told it is being recorded.
                  <span className="muted"> Required before we add it.</span>
                </span>
              </label>
            </Tooltip>
          </div>

          {createError && <Alert severity="critical" title="Could not add the meeting.">{createError}</Alert>}

          <div className="form-actions">
            <Tooltip
              content={
                !client
                  ? "Pick a client first."
                  : !consent
                    ? "Confirm consent to enable this."
                    : "Add this meeting. Next you can extract insights from it."
              }
              title="Add meeting"
            >
              {/* span wrapper so the tooltip still shows while the button is disabled */}
              <span>
                <Btn type="submit" variant="primary" disabled={!canSubmit}>
                  {submitting ? "Adding" : "Add meeting"}
                </Btn>
              </span>
            </Tooltip>
            {!consent && (
              <span className="helper">Confirm consent above to continue.</span>
            )}
          </div>
        </form>

        {/* recent meetings */}
        <div>
          <div className="row-between" style={{ marginBottom: 8 }}>
            <span className="lbl">Recent meetings</span>
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => void loadRecent()}
              tooltip="Reload the list of meetings."
            >
              Refresh
            </Btn>
          </div>
          <RecentMeetings recent={recent} error={recentError} onRetry={() => void loadRecent()} />
        </div>
      </div>
    </>
  );
}

// ============================================================ conversation tab button

function ConvTab({
  active,
  onClick,
  tip,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tip: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className={`btn sm ${active ? "primary" : "ghost"}`}
        onClick={onClick}
      >
        {children}
      </button>
    </Tooltip>
  );
}

// ============================================================ calendar event list

function CalendarEventList({
  onPick,
  pickedUid,
  clients,
}: {
  onPick: (ev: CalendarEvent) => void;
  pickedUid: string | null;
  clients: Client[];
}) {
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    setEvents(null);
    try {
      const r = await api.calendarEvents();
      setEvents(Array.isArray(r?.events) ? r.events : []);
    } catch (e) {
      setError(e);
      setEvents([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clientNameFor = useCallback(
    (ev: CalendarEvent): string | undefined => {
      if (ev.suggested_client_name) return ev.suggested_client_name;
      if (ev.suggested_client_id) {
        return clients.find((c) => c.id === ev.suggested_client_id)?.name;
      }
      return undefined;
    },
    [clients],
  );

  if (error) {
    return (
      <div className="card">
        <ErrorAlert error={error} onRetry={() => void load()} />
      </div>
    );
  }

  if (events === null) {
    return (
      <div className="card">
        <div className="lbl" style={{ marginBottom: 10 }}>
          From your calendar
        </div>
        <Skeleton rows={4} />
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="No upcoming meetings found."
          body="Nothing showed up in your calendar feed. You can still add a meeting by hand below."
        />
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0, maxWidth: 720 }}>
      <div className="row-between" style={{ padding: "12px 16px 8px" }}>
        <span className="lbl">From your calendar</span>
        <span className="tiny subtle mono">{events.length} found</span>
      </div>
      <div>
        {events.map((ev, i) => {
          const cName = clientNameFor(ev);
          const names = attendeeNames(ev);
          const selected = !!pickedUid && ev.uid === pickedUid;
          return (
            <button
              key={ev.uid ?? `${ev.title}-${i}`}
              type="button"
              className={`lcard${selected ? " sel" : ""}`}
              onClick={() => onPick(ev)}
              title="Use this meeting to fill in the form below."
            >
              <div className="t">{ev.title || "Untitled meeting"}</div>
              <div className="meta">
                <span>{ev.start ? formatDateTime(ev.start) : "No time"}</span>
                {names.length > 0 && (
                  <>
                    <span>·</span>
                    <span>
                      {names.slice(0, 3).join(", ")}
                      {names.length > 3 ? ` +${names.length - 3}` : ""}
                    </span>
                  </>
                )}
                {cName && (
                  <>
                    <span>·</span>
                    <span className="pill ins">{cName}</span>
                  </>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================ recent meetings list

function RecentMeetings({
  recent,
  error,
  onRetry,
}: {
  recent: Meeting[] | null;
  error: unknown;
  onRetry: () => void;
}) {
  const navigate = useNavigate();

  const sorted = useMemo(() => {
    if (!recent) return null;
    return [...recent].sort((a, b) => {
      const ta = new Date(a.created_at ?? a.meeting_date ?? 0).getTime();
      const tb = new Date(b.created_at ?? b.meeting_date ?? 0).getTime();
      return tb - ta;
    });
  }, [recent]);

  if (error && !recent?.length) {
    return <ErrorAlert error={error} onRetry={onRetry} />;
  }

  if (recent === null) {
    return (
      <div className="card">
        <Skeleton rows={4} />
      </div>
    );
  }

  if (recent.length === 0) {
    return (
      <div className="card">
        <EmptyState
          title="No meetings yet."
          body="Once you add a meeting it shows up here so you can jump back to it."
        />
      </div>
    );
  }

  return (
    <div className="table-wrap card" style={{ padding: 0 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Meeting</th>
            <th>Client</th>
            <th>When</th>
            <th>Added</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {(sorted ?? []).map((m) => {
            const seq = meetingSeq(m);
            const label =
              m.title?.trim() ||
              (seq !== undefined ? `Meeting ${seq}` : "Untitled meeting");
            return (
              <tr
                key={m.id}
                className="clickable"
                onClick={() => navigate("/")}
                title="Open Review to work on this meeting's insights."
              >
                <td>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                    {label}
                    {m.meeting_type && (
                      <span className="pill">{titleCase(String(m.meeting_type))}</span>
                    )}
                  </span>
                </td>
                <td>{m.client_name ?? "-"}</td>
                <td>{m.meeting_date ? formatDate(m.meeting_date) : "-"}</td>
                <td className="muted">{m.created_at ? ageOf(m.created_at) : "-"}</td>
                <td>
                  {m.status ? <StatePill state={m.status} /> : <span className="muted">-</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
