import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth";
import {
  api,
  ApiError,
  TRACKS,
  EVIDENCE_KINDS,
  insightHandle,
} from "../api";
import type {
  EmailDraft,
  EvidenceRecord,
  Insight,
  InsightDetail as InsightDetailData,
  Mention,
  Ticket,
  TimelineEvent,
  User,
} from "../api";
import {
  Alert,
  Btn,
  ConfirmModal,
  EmptyState,
  ErrorAlert,
  Field,
  Markdown,
  Modal,
  SectionHead,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import {
  ageOf,
  formatDate,
  insightTitle,
  itemTypeLabel,
  nextStep,
  stateLabel,
  stateTooltipFor,
  titleCase,
  trackLabel,
} from "../format";

// =================================================================== route page

// Named export `InsightDetail` keeps the App.tsx route import working.
// Also re-exported as the default page component per the page contract.
export function InsightDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  return (
    <>
      <SectionHead
        title="Insight"
        job="What was said, what we decided, and where it went."
        actions={
          <Btn
            variant="ghost"
            size="sm"
            onClick={() => navigate("/insights")}
            tooltip="Go back to the searchable list of every insight."
          >
            Back to Library
          </Btn>
        }
      />
      <div className="scroll">
        {id ? (
          <InsightDetailView insightId={id} />
        ) : (
          <div className="page-body">
            <EmptyState title="No insight selected." body="Open one from the Library." />
          </div>
        )}
      </div>
    </>
  );
}

export default InsightDetail;

// =================================================================== the embeddable view

const STEPPER: string[] = ["extracted", "triaged", "finalized", "ticketed", "shipped", "client_notified"];

function isTerminal(state: string | undefined): boolean {
  return state === "rejected" || state === "merged" || state === "closed";
}

/** Order index of a state in the happy path, for the stepper highlight. */
function stepIndex(state: string | undefined): number {
  if (!state) return -1;
  const i = STEPPER.indexOf(state);
  if (i >= 0) return i;
  if (state === "closed") return STEPPER.length; // closed sits past client_told
  return -1;
}

export function InsightDetailView({
  insightId,
  embedded = false,
}: {
  insightId: string;
  embedded?: boolean;
}) {
  const toast = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState<InsightDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  const [users, setUsers] = useState<User[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api.getInsight(insightId);
      setData(d);
    } catch (e) {
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [insightId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Users list for the owner picker. A non-admin may be denied; that is fine.
  useEffect(() => {
    let alive = true;
    api
      .listUsers()
      .then((u) => {
        if (alive) setUsers(u.filter((x) => !x.disabled_at));
      })
      .catch(() => {
        /* picker degrades to "owner not available" */
      });
    return () => {
      alive = false;
    };
  }, []);

  // refresh just the detail after any mutation, surfacing failures as a toast
  const refresh = useCallback(async () => {
    try {
      const d = await api.getInsight(insightId);
      setData(d);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Could not refresh.";
      toast.push(msg, "warning");
    }
  }, [insightId, toast]);

  if (loading) {
    return (
      <div style={{ padding: embedded ? "20px 24px" : 18 }}>
        <Skeleton rows={7} />
      </div>
    );
  }

  if (loadError || !data) {
    return (
      <div style={{ padding: embedded ? "20px 24px" : 18, maxWidth: 560 }}>
        <ErrorAlert error={loadError ?? new Error("This insight could not be found.")} onRetry={load} />
      </div>
    );
  }

  return (
    <DetailBody
      insightId={insightId}
      data={data}
      users={users}
      embedded={embedded}
      onChanged={refresh}
      onGone={() => {
        if (!embedded) navigate("/insights");
      }}
      toastPush={toast.push}
    />
  );
}

// =================================================================== body (data guaranteed)

function DetailBody({
  insightId,
  data,
  users,
  embedded,
  onChanged,
  onGone,
  toastPush,
}: {
  insightId: string;
  data: InsightDetailData;
  users: User[];
  embedded: boolean;
  onChanged: () => Promise<void>;
  onGone: () => void;
  toastPush: (m: string, s?: "info" | "success" | "warning" | "critical") => void;
}) {
  const insight: Insight = data.insight ?? { id: insightId };
  const state = String(insight.state ?? "extracted");
  const handle = data.handle ?? insight.handle ?? insightHandle(insightId);

  const mentions: Mention[] = Array.isArray(data.mentions) ? data.mentions : [];
  const tickets: Ticket[] = Array.isArray(data.tickets) ? data.tickets : [];
  const evidence: EvidenceRecord[] = Array.isArray(data.evidence) ? data.evidence : [];
  const emailDrafts: EmailDraft[] = Array.isArray(data.email_drafts) ? data.email_drafts : [];
  const timeline: TimelineEvent[] = Array.isArray(data.timeline) ? data.timeline : [];

  const firstMention = mentions[0];
  const clientName =
    insight.client_name ?? firstMention?.client_name ?? "Unknown client";
  const meetingSeq = firstMention?.meeting_seq ?? firstMention?.seq;
  const meetingDate = firstMention?.meeting_date;

  // ----- AI suggestion parsing (defensive: object or JSON string)
  const aiSuggested = useMemo(() => parseAi(insight.ai_suggested_json), [insight.ai_suggested_json]);

  // ----- body editor state
  const serverVersion = typeof insight.version === "number" ? insight.version : 0;
  const serverBody = insight.body_current ?? insight.body_original ?? "";
  const [body, setBody] = useState(serverBody);
  const [version, setVersion] = useState(serverVersion);
  const [bodyDirty, setBodyDirty] = useState(false);
  const [savingBody, setSavingBody] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  // resync when a refresh brings new server values (only when not mid-edit)
  useEffect(() => {
    if (!bodyDirty) {
      setBody(serverBody);
      setVersion(serverVersion);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverBody, serverVersion]);

  // ----- triage state
  const [track, setTrack] = useState<string>(insight.track ? String(insight.track) : "");
  const [assignee, setAssignee] = useState<string>(insight.assignee_user_id ? String(insight.assignee_user_id) : "");
  const [tags, setTags] = useState<string[]>(() => normalizeTags(data.tags));
  const [tagInput, setTagInput] = useState("");
  const [savingTriage, setSavingTriage] = useState(false);

  useEffect(() => {
    setTrack(insight.track ? String(insight.track) : "");
    setAssignee(insight.assignee_user_id ? String(insight.assignee_user_id) : "");
    setTags(normalizeTags(data.tags));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insight.track, insight.assignee_user_id, data.tags]);

  // wording can still be edited up to finalize; once finalized (and beyond) it is locked
  const wordingLocked = isTerminal(state) || stepIndex(state) >= 2;

  // ----- editing indicator (soft lock signal to teammates)
  const editingSent = useRef(false);
  const setEditing = useCallback(
    (on: boolean) => {
      if (on === editingSent.current) return;
      editingSent.current = on;
      api.setEditing(insightId, on).catch(() => {
        /* soft signal only; ignore */
      });
    },
    [insightId],
  );
  useEffect(() => {
    return () => {
      // release on unmount
      if (editingSent.current) api.setEditing(insightId, false).catch(() => undefined);
    };
  }, [insightId]);

  // ----- action-bar busy + modals
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [closeOpen, setCloseOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [mergeOpen, setMergeOpen] = useState(false);

  // ===================================================== body save
  async function saveBody() {
    if (savingBody) return;
    setSavingBody(true);
    setConflict(null);
    try {
      const r = await api.saveBody(insightId, body, version);
      const newVersion =
        r && typeof r === "object" && typeof (r as Record<string, unknown>).version === "number"
          ? ((r as Record<string, unknown>).version as number)
          : version + 1;
      setVersion(newVersion);
      setBodyDirty(false);
      setEditing(false);
      toastPush("Saved.", "success");
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const cur = readCurrentVersion(e.data);
        setConflict(cur ?? version);
      } else {
        toastPush(e instanceof Error ? e.message : "Could not save.", "critical");
      }
    } finally {
      setSavingBody(false);
    }
  }

  // ===================================================== triage save
  async function saveTriage() {
    if (!track) {
      toastPush("Pick a track first so it knows where this goes.", "warning");
      return;
    }
    setSavingTriage(true);
    try {
      await api.triage(insightId, {
        track,
        assignee_user_id: assignee || undefined,
        tags,
      });
      toastPush("Routed.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not save routing.", "critical");
    } finally {
      setSavingTriage(false);
    }
  }

  function applyAi() {
    if (aiSuggested.track) setTrack(aiSuggested.track);
    if (aiSuggested.assignee_user_id) {
      setAssignee(aiSuggested.assignee_user_id);
    } else if (aiSuggested.assignee_name) {
      const match = users.find(
        (u) => (u.name ?? "").toLowerCase() === aiSuggested.assignee_name!.toLowerCase(),
      );
      if (match) setAssignee(match.id);
    }
    toastPush("Filled in the AI's suggestion. Review it, then Save routing.", "info");
  }

  function addTag() {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    if (!tags.includes(t)) setTags([...tags, t]);
    setTagInput("");
  }

  // ===================================================== lifecycle actions
  async function runAction(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      toastPush(success, "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "That did not go through.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function doFinalize() {
    if (bodyDirty) {
      toastPush("Save your wording first, then finalize.", "warning");
      return;
    }
    await runAction("finalize", () => api.finalize(insightId), "Wording locked. It can now become a ticket.");
  }

  async function doReject() {
    if (!rejectReason.trim()) return;
    setBusy("reject");
    try {
      await api.rejectInsight(insightId, rejectReason.trim());
      toastPush("Rejected. It stays on record but goes no further.", "success");
      setRejectOpen(false);
      setRejectReason("");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not reject.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function doClose() {
    setBusy("close");
    try {
      await api.closeInsight(insightId, closeReason.trim() || undefined);
      toastPush("Closed. Nothing more to do here.", "success");
      setCloseOpen(false);
      setCloseReason("");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not close.", "critical");
    } finally {
      setBusy(null);
    }
  }

  const sortedTimeline = useMemo(
    () =>
      [...timeline].sort((a, b) => {
        const ta = a.occurred_at ? new Date(a.occurred_at).getTime() : 0;
        const tb = b.occurred_at ? new Date(b.occurred_at).getTime() : 0;
        return tb - ta; // newest first
      }),
    [timeline],
  );

  // Embedded inside Review's right pane gets the .detail panel chrome and the
  // signature green corner square. Standalone keeps page padding + the corner.
  const wrapClass = embedded ? "detail corner" : "page-body corner";

  return (
    <div className={wrapClass}>
      <div style={detailGrid(embedded)}>
        {/* ============================ LEFT: editorial work area ============================ */}
        <div>
          {/* state stepper */}
          <StateStepper state={state} />

          {/* the one legal next move, in plain words, directly under the spine */}
          {!isTerminal(state) && nextStep(state) && (
            <div className="nextstep">
              <span className="tick" aria-hidden="true" />
              <span className="lead">Next</span>
              <span>
                <span className="verb">{nextStep(state)!.verb}.</span>{" "}
                <span className="hint">{nextStep(state)!.hint}</span>
              </span>
            </div>
          )}

          {isTerminal(state) && (
            <div style={{ margin: "0 0 14px" }}>
              <Alert
                severity={state === "rejected" ? "critical" : "info"}
                title={state === "rejected" ? "This was rejected." : state === "merged" ? "This was merged." : "This is closed."}
              >
                <p style={{ margin: 0 }}>{stateTooltipFor(state)}</p>
              </Alert>
            </div>
          )}

          <h2 className="htitle">
            {insightTitle(insight.title) || "Untitled insight"}
          </h2>
          <div className="hsub mb-8">
            {handle}
            {" · "}
            {clientName}
            {meetingSeq != null && ` · meeting ${meetingSeq}`}
            {meetingDate && ` · ${formatDate(meetingDate)}`}
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            {insight.item_type && (
              <Tooltip title="What kind of thing this is" content={itemTypeLabel(insight.item_type)}>
                <span className="pill">{itemTypeLabel(insight.item_type)}</span>
              </Tooltip>
            )}
            <Tooltip title="Where this is in the pipeline" content={stateTooltipFor(state)}>
              <span>
                <StatePill state={state} />
              </span>
            </Tooltip>
            {insight.ai_confidence && (
              <Tooltip
                title="How sure the AI was"
                content="The AI's own confidence when it pulled this out of the meeting."
              >
                <span className="pill ins">AI {String(insight.ai_confidence)}</span>
              </Tooltip>
            )}
          </div>

          {/* AI read: who said it (client vs us), the client's sentiment, and their underlying intent */}
          {(insight.side || insight.sentiment || insight.intent) && (
            <p className="tiny muted" style={{ margin: "0 0 6px" }}>
              {insight.side && insight.side !== "unknown" && (
                <span>From: {insight.side === "client" ? "client" : "our team"}</span>
              )}
              {insight.sentiment && <span> · sentiment: {insight.sentiment}</span>}
              {insight.intent && <span> · intent: {insight.intent}</span>}
            </p>
          )}

          {/* editing-by soft indicator */}
          {insight.editing_by_name && (
            <p className="tiny muted" style={{ margin: "2px 0 0" }}>
              {String(insight.editing_by_name)} is editing this now.
            </p>
          )}

          {/* verbatim quotes */}
          <div className="dlbl">
            What the client actually said
            {mentions.length > 1 && (
              <Tooltip
                title="Asked more than once"
                content={`This came up in ${mentions.length} separate mentions across meetings. Demand is real.`}
              >
                <span style={{ color: "var(--accent-soft)", marginLeft: 8, textTransform: "none", letterSpacing: 0 }}>
                  asked {mentions.length} times
                </span>
              </Tooltip>
            )}
          </div>
          {mentions.length === 0 ? (
            <p className="muted small maxw-680">
              No verbatim quote was captured for this one.
            </p>
          ) : (
            <div className="stack-sm maxw-680">
              {mentions.map((m, i) => (
                <div className="quote" key={m.id ?? i}>
                  {m.quote || "(no quote text)"}
                  <span className="by">
                    {[m.speaker || "Unknown speaker", m.client_name, m.meeting_seq != null ? `meeting ${m.meeting_seq}` : null, m.meeting_date ? formatDate(m.meeting_date) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* polished body editor */}
          <div className="dlbl">
            {wordingLocked ? "Final wording" : "Summary (edit before you finalize)"}
            <Tooltip
              title="The wording we keep"
              content="This is the version we use everywhere downstream: tickets, emails, the client view. Edit it until it is right, then Save."
            >
              <span className="help" style={{ marginLeft: 6 }} tabIndex={0}>?</span>
            </Tooltip>
          </div>

          {conflict !== null && (
            <div style={{ maxWidth: 680, marginBottom: 8 }}>
              <Alert severity="warning" title="Someone else saved a newer version.">
                <p className="mb-8">
                  Your copy is out of date (you had version {version}, the server has version {conflict}). Reload to
                  see their changes, then re-apply yours.
                </p>
                <Btn size="sm" onClick={() => { setConflict(null); void onChanged(); }} tooltip="Pull the latest wording from the server. Your unsaved text will be replaced.">
                  Reload latest
                </Btn>
              </Alert>
            </div>
          )}

          <textarea
            className="ctrl"
            style={{ maxWidth: 680, minHeight: 130 }}
            value={body}
            disabled={wordingLocked || savingBody}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => {
              setBody(e.target.value);
              setBodyDirty(e.target.value !== serverBody);
            }}
            placeholder="Write the polished summary the rest of the team and the client will see."
          />
          <div className="row" style={{ marginTop: 8, maxWidth: 680 }}>
            <Tooltip
              content={
                wordingLocked
                  ? "The wording is locked because this has been finalized."
                  : !bodyDirty
                    ? "Nothing to save yet. Edit the summary first."
                    : "Save this wording. Everything downstream uses what you save here."
              }
            >
              {/* span wrapper so the tooltip still shows while the button is disabled */}
              <span>
                {/* Secondary, matching Review: saving wording is a sub-step of the
                    editor, not the screen's primary move. The one primary is the
                    pipeline advance named in the Next-step banner (Route it /
                    Finalize), so wording stays a quiet default button. */}
                <Btn
                  size="sm"
                  disabled={wordingLocked || savingBody || !bodyDirty}
                  onClick={saveBody}
                >
                  {savingBody ? "Saving" : "Save wording"}
                </Btn>
              </span>
            </Tooltip>
            {bodyDirty && !wordingLocked && (
              <span className="tiny muted">Unsaved changes.</span>
            )}
            {insight.body_original && insight.body_original !== body && (
              <Btn
                variant="ghost"
                size="sm"
                onClick={() => setShowOriginal((v) => !v)}
                tooltip="See exactly what the AI first wrote, before anyone edited it."
              >
                {showOriginal ? "Hide AI original" : "Show AI original"}
              </Btn>
            )}
          </div>
          {showOriginal && insight.body_original && (
            <div className="bodybox" style={{ maxWidth: 680, marginTop: 8, color: "var(--ink-muted)" }}>
              <div className="lbl" style={{ margin: "0 0 6px" }}>AI original (read only)</div>
              {insight.body_original}
            </div>
          )}

          {/* AI suggestion strip (hidden when the line is empty, e.g. a bare "Other") */}
          {aiSuggestionLine(aiSuggested) !== "" && !wordingLocked && (
            <div className="aibox">
              {aiSuggestionLine(aiSuggested)}{" "}
              <Tooltip title="Apply the suggestion" content="Fills the routing controls below with the AI's guess. You still review and Save it yourself.">
                <button
                  onClick={applyAi}
                  style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "inherit", padding: 0 }}
                >
                  Apply suggestion
                </button>
              </Tooltip>
            </div>
          )}

          {/* triage controls */}
          {!isTerminal(state) && (
            <>
              <div className="dlbl">Route it</div>
              <div className="row" style={{ gap: 18, alignItems: "flex-start", maxWidth: 680 }}>
                <Field label="Track" htmlFor="ins-track" help="Which side of the house this belongs to: build it, polish it, market it, or other.">
                  <select
                    id="ins-track"
                    className="ctrl"
                    style={{ minWidth: 150 }}
                    value={track}
                    onChange={(e) => setTrack(e.target.value)}
                  >
                    <option value="">Pick a track</option>
                    {TRACKS.map((t) => (
                      <option key={t} value={t}>
                        {trackLabel(t)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Owner" htmlFor="ins-owner" help="The person responsible for moving this forward.">
                  <select
                    id="ins-owner"
                    className="ctrl"
                    style={{ minWidth: 160 }}
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                  >
                    <option value="">No owner yet</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name || u.email}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="field">
                  <label>Tags</label>
                  <div className="chips">
                    {tags.map((t) => (
                      <span className="chip" key={t}>
                        {t}
                        <button
                          aria-label={`Remove tag ${t}`}
                          onClick={() => setTags(tags.filter((x) => x !== t))}
                          style={{ background: "none", border: "none", color: "var(--ink-subtle)", cursor: "pointer", padding: 0, fontFamily: "var(--mono)" }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    <input
                      className="ctrl"
                      style={{ width: 110, padding: "4px 8px", fontSize: 11 }}
                      value={tagInput}
                      placeholder="add tag"
                      onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addTag();
                        }
                      }}
                      onBlur={addTag}
                    />
                  </div>
                </div>
              </div>
              <div className="row" style={{ marginTop: 12, maxWidth: 680 }}>
                <Tooltip
                  content={
                    !track
                      ? "Pick a track first so it knows where this goes."
                      : "Save where this goes and who owns it. This moves it to Routed if it was new."
                  }
                >
                  {/* span wrapper so the tooltip still shows while the button is disabled */}
                  <span>
                    {/* For a Found insight, routing IS the one legal next move, so
                        it leads as the primary. Once Routed, Finalize takes the
                        primary slot below and this stays a quiet re-route. */}
                    <Btn
                      size="sm"
                      variant={state === "extracted" ? "primary" : "default"}
                      disabled={savingTriage || !track}
                      onClick={saveTriage}
                    >
                      {savingTriage ? "Saving" : "Save routing"}
                    </Btn>
                  </span>
                </Tooltip>
              </div>
            </>
          )}

          {/* action bar */}
          <div className="actions">
            {!isTerminal(state) && state === "triaged" && (
              <Tooltip
                content={
                  bodyDirty
                    ? "Save your wording first, then finalize."
                    : "Locks the wording. After this it can become a ticket or be marked shipped."
                }
              >
                {/* span wrapper so the tooltip still shows while the button is disabled */}
                <span>
                  <Btn
                    variant="primary"
                    disabled={busy !== null || bodyDirty}
                    onClick={doFinalize}
                  >
                    {busy === "finalize" ? "Locking" : "Finalize wording"}
                  </Btn>
                </span>
              </Tooltip>
            )}
            {!isTerminal(state) && (
              <Btn
                variant="ghost"
                className="danger"
                disabled={busy !== null}
                onClick={() => setRejectOpen(true)}
                tooltip="Wrong or not useful. It stays on record but stops here."
              >
                Reject
              </Btn>
            )}
            {!isTerminal(state) && (
              <Btn
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setMergeOpen(true)}
                tooltip="Fold this into another insight that says the same thing. This one becomes a duplicate."
              >
                Merge
              </Btn>
            )}
            {!isTerminal(state) && stepIndex(state) >= 2 && (
              <Btn
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setCloseOpen(true)}
                tooltip="Put this to rest. Use it when the work is done and there is nothing left to do."
              >
                Close
              </Btn>
            )}
          </div>
          {!isTerminal(state) && state === "triaged" && (
            <p className="helper" style={{ marginTop: 6, maxWidth: 680 }}>
              Finalize locks the wording - you cannot edit the summary afterwards.
            </p>
          )}
        </div>

        {/* ============================ RIGHT: lifecycle rail ============================ */}
        <div className="stack" style={{ minWidth: 0 }}>
          <TimelinePanel events={sortedTimeline} />
          <TicketPanel
            insightId={insightId}
            tickets={tickets}
            disabled={busy !== null}
            onChanged={onChanged}
            toastPush={toastPush}
          />
          <EvidencePanel
            insightId={insightId}
            evidence={evidence}
            onChanged={onChanged}
            toastPush={toastPush}
          />
          <EmailPanel
            insightId={insightId}
            drafts={emailDrafts}
            onChanged={onChanged}
            toastPush={toastPush}
          />
        </div>
      </div>

      {/* ---------- modals ---------- */}
      <Modal
        open={rejectOpen}
        title="Reject this insight"
        onClose={() => setRejectOpen(false)}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setRejectOpen(false)} disabled={busy === "reject"}>
              Cancel
            </Btn>
            <Btn variant="danger" onClick={doReject} disabled={busy === "reject" || !rejectReason.trim()}>
              {busy === "reject" ? "Rejecting" : "Reject"}
            </Btn>
          </>
        }
      >
        <Field label="Why reject it" htmlFor="reject-reason" hint="A short note so the record makes sense later. Required.">
          <textarea
            id="reject-reason"
            className="ctrl"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder="e.g. Duplicate of an older insight, or not something we will build."
          />
        </Field>
      </Modal>

      <Modal
        open={closeOpen}
        title="Close this insight"
        onClose={() => setCloseOpen(false)}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setCloseOpen(false)} disabled={busy === "close"}>
              Cancel
            </Btn>
            <Btn variant="primary" onClick={doClose} disabled={busy === "close"}>
              {busy === "close" ? "Closing" : "Close it"}
            </Btn>
          </>
        }
      >
        <Field label="Closing note" htmlFor="close-reason" hint="Optional. Anything worth remembering about why this is done.">
          <textarea
            id="close-reason"
            className="ctrl"
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder="Optional"
          />
        </Field>
      </Modal>

      <MergeModal
        open={mergeOpen}
        currentId={insightId}
        currentClientId={insight.client_id ? String(insight.client_id) : undefined}
        onClose={() => setMergeOpen(false)}
        onMerged={async () => {
          setMergeOpen(false);
          toastPush("Merged into the other insight.", "success");
          await onChanged();
          onGone();
        }}
        toastPush={toastPush}
      />
    </div>
  );
}

function detailGrid(embedded: boolean): React.CSSProperties {
  return {
    display: "grid",
    gridTemplateColumns: embedded ? "minmax(0,1fr)" : "minmax(0,1.4fr) minmax(300px,0.9fr)",
    gap: 28,
    alignItems: "start",
  };
}

// =================================================================== state stepper

// Exported so Review's queue detail pane renders the exact same stepper:
// one vocabulary (stateLabel), current stage = accent, done stages = success.
export function StateStepper({ state }: { state: string }) {
  const cur = stepIndex(state);
  return (
    <div className="states mb-16">
      {STEPPER.map((s, i) => {
        let cls = "st";
        if (isTerminal(state)) {
          cls = i <= cur ? "st done" : "st muted";
        } else if (i === cur) {
          cls = "st on";
        } else if (i < cur) {
          cls = "st done";
        } else {
          cls = "st muted";
        }
        return (
          <Tooltip key={s} title={stateLabel(s)} content={stateTooltipFor(s)}>
            <span className={cls}>{stateLabel(s)}</span>
          </Tooltip>
        );
      })}
      {state === "rejected" && (
        <Tooltip title="Rejected" content={stateTooltipFor("rejected")}>
          <span className="st red">{stateLabel("rejected")}</span>
        </Tooltip>
      )}
      {state === "merged" && (
        <Tooltip title="Merged" content={stateTooltipFor("merged")}>
          <span className="st muted">{stateLabel("merged")}</span>
        </Tooltip>
      )}
    </div>
  );
}

// =================================================================== timeline panel

function TimelinePanel({ events }: { events: TimelineEvent[] }) {
  return (
    <section className="card p-16">
      <div className="lbl" style={{ margin: "0 0 12px" }}>History</div>
      {events.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>Nothing has happened yet.</p>
      ) : (
        <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {events.map((e, i) => (
            <li key={e.id ?? i} style={{ display: "flex", gap: 10, paddingBottom: i === events.length - 1 ? 0 : 12 }}>
              <span
                style={{ width: 6, height: 6, borderRadius: 1, marginTop: 6, flex: "0 0 auto", background: e.to_state ? "var(--accent)" : "var(--ink-subtle)" }}
                aria-hidden="true"
              />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{timelineLabel(e)}</div>
                <div className="tiny subtle mono">
                  {[e.actor_name, e.occurred_at ? `${ageOf(e.occurred_at)} ago` : null].filter(Boolean).join(" · ")}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function timelineLabel(e: TimelineEvent): string {
  const ev = String(e.event_type ?? "");
  if (e.from_state && e.to_state) {
    return `Moved from ${stateLabel(e.from_state)} to ${stateLabel(e.to_state)}`;
  }
  if (e.to_state) return `Reached ${stateLabel(e.to_state)}`;
  const EVENT_LABELS: Record<string, string> = {
    created: "Created",
    extracted: "Pulled from a meeting by the AI",
    body_edited: "Wording edited",
    triaged: "Routed",
    finalized: "Wording locked",
    ticket_drafted: "Ticket drafted",
    ticket_raised: "Ticket raised in GitHub",
    evidence_proposed: "Proof of shipping proposed",
    evidence_confirmed: "Proof of shipping confirmed",
    evidence_rejected: "Proof of shipping rejected",
    email_drafted: "Client email drafted",
    email_copied: "Client email copied",
    email_sent: "Client told",
    rejected: "Rejected",
    merged: "Merged into another insight",
    closed: "Closed",
  };
  return EVENT_LABELS[ev] ?? (titleCase(ev) || "Update");
}

// =================================================================== ticket panel

function TicketPanel({
  insightId,
  tickets,
  disabled,
  onChanged,
  toastPush,
}: {
  insightId: string;
  tickets: Ticket[];
  disabled: boolean;
  onChanged: () => Promise<void>;
  toastPush: (m: string, s?: "info" | "success" | "warning" | "critical") => void;
}) {
  const { writableRepos } = useAuth();
  const [drafting, setDrafting] = useState(false);
  const [urlByTicket, setUrlByTicket] = useState<Record<string, string>>({});
  const [repoByTicket, setRepoByTicket] = useState<Record<string, string>>({});
  const [acting, setActing] = useState<string | null>(null);

  async function draft() {
    setDrafting(true);
    try {
      await api.generateTicketDraft(insightId);
      toastPush("Ticket drafted. Review it, then raise it yourself.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not draft a ticket.", "critical");
    } finally {
      setDrafting(false);
    }
  }

  async function copyBody(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toastPush("Copied the ticket text.", "success");
    } catch {
      toastPush("Could not reach the clipboard. Select and copy by hand.", "warning");
    }
  }

  async function markRaised(ticketId: string) {
    const url = (urlByTicket[ticketId] ?? "").trim();
    if (!url) {
      toastPush("Paste the issue URL first.", "warning");
      return;
    }
    setActing(ticketId);
    try {
      await api.markRaised(ticketId, url);
      toastPush("Marked as raised.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not mark it raised.", "critical");
    } finally {
      setActing(null);
    }
  }

  async function createDirect(ticketId: string) {
    const repo = repoByTicket[ticketId] ?? writableRepos[0];
    if (!repo) return;
    setActing(ticketId);
    try {
      await api.createDirect(ticketId, repo);
      toastPush("Created the issue on GitHub.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not create it on GitHub.", "critical");
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="card p-16">
      <div className="row-between mb-12">
        <div className="lbl" style={{ margin: 0 }}>Ticket</div>
        <Btn
          size="sm"
          disabled={drafting || disabled}
          onClick={draft}
          tooltip="Write a GitHub issue from this insight. Nothing is created yet, you just get a draft to review."
        >
          {drafting ? "Drafting" : "Draft ticket"}
        </Btn>
      </div>

      {tickets.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>No ticket yet. Draft one when the wording is final.</p>
      ) : (
        <div className="stack-sm">
          {tickets.map((t) => {
            const draftText = t.body_draft ?? t.draft ?? "";
            const externalUrl = t.external_url ?? t.issue_url ?? null;
            return (
              <div key={t.id} style={{ border: "1px solid var(--line-soft)", borderRadius: "var(--r)", padding: 10 }}>
                <div className="row-between mb-8">
                  <span className="tiny mono subtle">{t.repo || writableRepos[0] || "GitHub"}</span>
                  <StatePill state={t.state} />
                </div>
                {t.title && <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>{t.title}</div>}
                {draftText && (
                  <>
                    <pre
                      className="mono"
                      style={{ background: "var(--p1)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 10, fontSize: 11, lineHeight: 1.55, maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", margin: "0 0 8px" }}
                    >
                      {draftText}
                    </pre>
                    <Btn size="sm" variant="ghost" onClick={() => copyBody(draftText)} tooltip="Copy this draft so you can paste it into GitHub yourself.">
                      Copy draft
                    </Btn>
                  </>
                )}

                {externalUrl ? (
                  <p className="tiny mt-8">
                    Raised:{" "}
                    <a href={externalUrl} target="_blank" rel="noreferrer">
                      {externalUrl}
                    </a>
                  </p>
                ) : (
                  <div className="stack-sm mt-10">
                    <div className="row gap-6">
                      <input
                        className="ctrl"
                        style={{ flex: 1, minWidth: 0 }}
                        placeholder="Paste the issue URL"
                        value={urlByTicket[t.id] ?? ""}
                        onChange={(e) => setUrlByTicket((m) => ({ ...m, [t.id]: e.target.value }))}
                      />
                      <Btn
                        size="sm"
                        disabled={acting === t.id}
                        onClick={() => markRaised(t.id)}
                        tooltip="Tell the system you raised this issue manually. Paste the link so we can track it through to shipped."
                      >
                        Mark raised
                      </Btn>
                    </div>
                    {writableRepos.length > 0 && (
                      <div className="row gap-6">
                        <select
                          className="ctrl"
                          style={{ flex: 1, minWidth: 0 }}
                          value={repoByTicket[t.id] ?? writableRepos[0]}
                          onChange={(e) => setRepoByTicket((m) => ({ ...m, [t.id]: e.target.value }))}
                        >
                          {writableRepos.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <Btn
                          size="sm"
                          disabled={acting === t.id}
                          onClick={() => createDirect(t.id)}
                          tooltip="Create this issue on GitHub right now, in the repo you pick. You choose to do this; it never happens on its own."
                        >
                          Create on GitHub
                        </Btn>
                      </div>
                    )}
                    <p className="tiny subtle" style={{ margin: 0 }}>
                      Nothing is ever created automatically. You choose.
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// =================================================================== evidence panel

function EvidencePanel({
  insightId,
  evidence,
  onChanged,
  toastPush,
}: {
  insightId: string;
  evidence: EvidenceRecord[];
  onChanged: () => Promise<void>;
  toastPush: (m: string, s?: "info" | "success" | "warning" | "critical") => void;
}) {
  const [kind, setKind] = useState<string>(EVIDENCE_KINDS[0]);
  const [url, setUrl] = useState("");
  const [proposing, setProposing] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function propose() {
    setProposing(true);
    try {
      await api.proposeEvidence(insightId, { kind, url: url.trim() || undefined });
      toastPush("Added. Confirm it once you have eyes on the proof.", "success");
      setUrl("");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not add that proof.", "critical");
    } finally {
      setProposing(false);
    }
  }

  async function confirm(id: string) {
    setActing(id);
    try {
      await api.confirmEvidence(id);
      toastPush("Confirmed it shipped.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not confirm.", "critical");
    } finally {
      setActing(null);
    }
  }

  async function reject() {
    if (!rejectFor || !rejectReason.trim()) return;
    setActing(rejectFor);
    try {
      await api.rejectEvidence(rejectFor, rejectReason.trim());
      toastPush("Rejected that proof.", "success");
      setRejectFor(null);
      setRejectReason("");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not reject.", "critical");
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="card p-16">
      <div className="row-between mb-12">
        <div className="lbl" style={{ margin: 0 }}>Proof it shipped</div>
        <Tooltip title="What this is" content="The evidence that what the client asked for is actually live. Confirm it before you tell them.">
          <span className="help" tabIndex={0}>?</span>
        </Tooltip>
      </div>

      {evidence.length === 0 ? (
        <p className="muted small" style={{ margin: "0 0 12px" }}>No proof on record yet.</p>
      ) : (
        <div className="stack-sm mb-14">
          {evidence.map((ev) => (
            <div key={ev.id} style={{ border: "1px solid var(--line-soft)", borderRadius: "var(--r)", padding: 10 }}>
              <div className="row-between mb-4">
                <span className="tiny mono subtle">{titleCase(ev.kind)}</span>
                <StatePill state={ev.status} />
              </div>
              {ev.url && (
                <p className="tiny" style={{ margin: "0 0 6px", wordBreak: "break-all" }}>
                  <a href={ev.url} target="_blank" rel="noreferrer">{ev.url}</a>
                </p>
              )}
              {ev.notes && <p className="tiny muted" style={{ margin: "0 0 6px" }}>{ev.notes}</p>}
              {String(ev.status ?? "").toLowerCase() === "proposed" && (
                <div className="row gap-6">
                  <Btn size="sm" disabled={acting === ev.id} onClick={() => confirm(ev.id)} tooltip="Confirm this is real proof. This is what lets us tell the client it shipped.">
                    Confirm
                  </Btn>
                  <Btn size="sm" variant="ghost" className="danger" disabled={acting === ev.id} onClick={() => setRejectFor(ev.id)} tooltip="Not good enough proof. Send it back.">
                    Reject
                  </Btn>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="stack-sm">
        <div className="field">
          <label htmlFor={`ev-kind-${insightId}`}>Add proof</label>
          <select id={`ev-kind-${insightId}`} className="ctrl" value={kind} onChange={(e) => setKind(e.target.value)}>
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </select>
        </div>
        <div className="row gap-6">
          <input
            className="ctrl"
            style={{ flex: 1, minWidth: 0 }}
            placeholder="Link to the proof (optional)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <Btn size="sm" disabled={proposing} onClick={propose} tooltip="Record a piece of proof that this shipped. You confirm it as a separate step.">
            {proposing ? "Adding" : "Add"}
          </Btn>
        </div>
      </div>

      <ConfirmModal
        open={rejectFor !== null}
        title="Reject this proof"
        danger
        confirmLabel="Reject proof"
        busy={acting === rejectFor && rejectFor !== null}
        onClose={() => {
          setRejectFor(null);
          setRejectReason("");
        }}
        onConfirm={reject}
        body={
          <Field label="Why reject it" htmlFor="ev-reject" hint="Required.">
            <textarea
              id="ev-reject"
              className="ctrl"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. The link does not actually show the feature live."
            />
          </Field>
        }
      />
    </section>
  );
}

// =================================================================== email panel

function EmailPanel({
  insightId,
  drafts,
  onChanged,
  toastPush,
}: {
  insightId: string;
  drafts: EmailDraft[];
  onChanged: () => Promise<void>;
  toastPush: (m: string, s?: "info" | "success" | "warning" | "critical") => void;
}) {
  const [generating, setGenerating] = useState(false);
  const [acting, setActing] = useState<string | null>(null);

  async function generate() {
    setGenerating(true);
    try {
      await api.generateEmailDrafts(insightId);
      toastPush("Drafts ready. Copy one to tell the client.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not generate drafts.", "critical");
    } finally {
      setGenerating(false);
    }
  }

  async function copyEmail(d: EmailDraft) {
    const bodyText = d.body ?? d.body_draft ?? "";
    const text = d.subject ? `Subject: ${d.subject}\n\n${bodyText}` : bodyText;
    setActing(d.id);
    try {
      const ok = await copyPlainText(text);
      if (!ok) {
        toastPush("Could not reach the clipboard. Select the text and copy it by hand.", "warning");
        return;
      }
      toastPush("Copied. Paste it into your email client.", "success");
      // Copying is the tracked send-proxy moment: record it so the client is marked told.
      try {
        await api.emailCopied(d.id);
        await onChanged();
      } catch {
        toastPush("Copied, but we could not record it. Press Copy email again so it counts.", "warning");
      }
    } finally {
      setActing(null);
    }
  }

  async function copySubject(d: EmailDraft) {
    const ok = await copyPlainText(d.subject ?? "");
    if (ok) {
      toastPush("Subject copied.", "success");
    } else {
      toastPush("Could not reach the clipboard. Copy the subject by hand.", "warning");
    }
  }

  async function markSent(d: EmailDraft) {
    setActing(d.id);
    try {
      await api.emailSentConfirm(d.id);
      toastPush("Marked as sent.", "success");
      await onChanged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not mark sent.", "critical");
    } finally {
      setActing(null);
    }
  }

  return (
    <section className="card p-16">
      <div className="row-between mb-12">
        <div className="lbl" style={{ margin: 0 }}>Tell the client</div>
        <Btn
          size="sm"
          disabled={generating}
          onClick={generate}
          tooltip={drafts.length > 0 ? "Write fresh drafts, replacing the current ones." : "Write a short email per client telling them what shipped. You review and send it yourself."}
        >
          {generating ? "Writing" : drafts.length > 0 ? "Regenerate" : "Generate drafts"}
        </Btn>
      </div>

      {drafts.length === 0 ? (
        <p className="muted small" style={{ margin: 0 }}>No drafts yet. Generate one once the proof is confirmed.</p>
      ) : (
        <div className="stack-sm">
          {drafts.map((d) => {
            const bodyText = d.body ?? d.body_draft ?? "";
            return (
              <div key={d.id} style={{ border: "1px solid var(--line-soft)", borderRadius: "var(--r)", padding: 10 }}>
                <div className="row-between mb-6">
                  <span className="tiny mono subtle">{d.client_name || "Client"}</span>
                  {(d.sent_confirmed_at || String(d.status ?? "") === "sent") && (
                    <Tooltip title="Sent" content="You confirmed this email went out to the client.">
                      <span className="st green">Sent</span>
                    </Tooltip>
                  )}
                  {!d.sent_confirmed_at && d.copied_at && (
                    <Tooltip title="Copied" content="The text was copied to your clipboard. Confirm once you have actually sent it.">
                      <span className="st white">Copied</span>
                    </Tooltip>
                  )}
                </div>
                <div style={{ fontSize: 12.5, marginBottom: 6 }}>
                  <strong>{d.subject || "(no subject)"}</strong>
                </div>
                <div
                  style={{ background: "var(--p1)", border: "1px solid var(--line)", borderRadius: "var(--r)", padding: 10, fontSize: 11.5, lineHeight: 1.55, maxHeight: 200, overflow: "auto", margin: "0 0 8px" }}
                >
                  {bodyText ? <Markdown text={bodyText} /> : <span className="muted">(empty draft)</span>}
                </div>
                <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                  <Btn
                    size="sm"
                    variant="primary"
                    disabled={acting === d.id}
                    onClick={() => copyEmail(d)}
                    tooltip="Copy the subject and body as plain text. Paste them into your mail app to send."
                  >
                    Copy email
                  </Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={acting === d.id || !d.subject}
                    onClick={() => copySubject(d)}
                    tooltip="Copy just the subject line."
                  >
                    Copy subject
                  </Btn>
                  <Btn
                    size="sm"
                    variant="ghost"
                    disabled={acting === d.id}
                    onClick={() => markSent(d)}
                    tooltip="Confirm you actually sent this. This closes the loop for the client."
                  >
                    Mark sent
                  </Btn>
                </div>
                <p className="tiny subtle" style={{ margin: "6px 0 0" }}>
                  Copy email records the client as told. Mark sent confirms it actually went out.
                </p>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// =================================================================== merge modal

function MergeModal({
  open,
  currentId,
  currentClientId,
  onClose,
  onMerged,
  toastPush,
}: {
  open: boolean;
  currentId: string;
  currentClientId?: string;
  onClose: () => void;
  onMerged: () => Promise<void>;
  toastPush: (m: string, s?: "info" | "success" | "warning" | "critical") => void;
}) {
  const [options, setOptions] = useState<Insight[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api
      .listInsights(currentClientId ? { client_id: currentClientId } : {})
      .then((list) => setOptions(list.filter((x) => x.id !== currentId)))
      .catch(() => toastPush("Could not load other insights to merge into.", "warning"))
      .finally(() => setLoading(false));
  }, [open, currentClientId, currentId, toastPush]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => (o.title ?? "").toLowerCase().includes(q));
  }, [options, query]);

  async function doMerge() {
    if (!target) return;
    setBusy(true);
    try {
      await api.mergeInsight(currentId, target);
      await onMerged();
    } catch (e) {
      toastPush(e instanceof Error ? e.message : "Could not merge.", "critical");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Merge into another insight"
      onClose={onClose}
      width={520}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={doMerge} disabled={busy || !target}>
            {busy ? "Merging" : "Merge"}
          </Btn>
        </>
      }
    >
      <p className="mt-0">
        This insight becomes a duplicate of the one you pick. Its mentions count toward that one instead.
      </p>
      {loading ? (
        <Skeleton rows={4} />
      ) : options.length === 0 ? (
        <p className="muted small">No other insights to merge into.</p>
      ) : (
        <>
          <Field label="Find the insight to keep" htmlFor="merge-search">
            <input
              id="merge-search"
              className="ctrl"
              placeholder="Search by title"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </Field>
          <div style={{ maxHeight: 280, overflowY: "auto", marginTop: 10 }}>
            {filtered.length === 0 ? (
              <p className="muted small">No matches.</p>
            ) : (
              filtered.map((o) => (
                <button
                  key={o.id}
                  className={`lcard${target === o.id ? " sel" : ""}`}
                  onClick={() => setTarget(o.id)}
                  style={{ border: "none", borderBottom: "1px solid var(--line-soft)" }}
                >
                  <div className="t">{insightTitle(o.title) || "Untitled"}</div>
                  <div className="meta">
                    {o.client_name && <span>{o.client_name}</span>}
                    <StatePill state={o.state} />
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

// =================================================================== helpers (local)

/**
 * Copy plain text to the clipboard. Uses the async clipboard API where it is
 * available (secure contexts only), and falls back to the hidden-textarea
 * execCommand trick so copying still works over plain http.
 */
async function copyPlainText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the textarea fallback */
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

interface AiSuggestion {
  track?: string;
  owner?: string;
  assignee_name?: string;
  assignee_user_id?: string;
}

/** One properly-cased sentence for the AI suggestion strip. */
function aiSuggestionLine(s: AiSuggestion): string {
  const owner = s.assignee_name ?? s.owner;
  if (s.track && owner) {
    return `AI suggests routing this to ${trackLabel(s.track)}, owned by ${owner}.`;
  }
  if (s.track === "other" && !owner) return "";
  if (s.track) return `AI suggests routing this to ${trackLabel(s.track)}.`;
  if (owner) return `AI suggests ${owner} as the owner.`;
  return "";
}

function parseAi(raw: unknown): AiSuggestion {
  let obj: Record<string, unknown> | null = null;
  if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") obj = parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (!obj) return {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v.trim() : undefined;
  return {
    track: str(obj.track),
    owner: str(obj.owner),
    assignee_name: str(obj.assignee_name) ?? str(obj.assignee) ?? str(obj.person) ?? undefined,
    assignee_user_id: str(obj.assignee_user_id),
  };
}

function normalizeTags(raw: InsightDetailData["tags"]): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      if (t.trim()) out.push(t.trim());
    } else if (t && typeof t === "object") {
      const v = t.tag ?? t.name;
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  }
  return out;
}

function readCurrentVersion(data: unknown): number | null {
  if (data && typeof data === "object") {
    const v = (data as Record<string, unknown>).current_version;
    if (typeof v === "number") return v;
  }
  return null;
}
