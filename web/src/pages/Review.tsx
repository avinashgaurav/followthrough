import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, TRACKS } from "../api";
import type { InsightDetail as InsightDetailData, Mention, QueueItem, User } from "../api";
import { useAuth } from "../auth";
import { useListSelection } from "../components/shortcuts";
import {
  Btn,
  EmptyState,
  ErrorAlert,
  ItemTypePill,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import { ageOf, formatDate, relativeAge, stateLabel, trackLabel } from "../format";

// Job: decide what each insight is and polish it before it moves.
// Two-pane triage screen, matching design-reference/APPROVED-review-mockup.html:
//   left  = GET /api/queue rendered as plain-language buckets, j/k to move, Enter to focus
//   right = the full insight-detail view (loaded via api.getInsight) with states stepper,
//           verbatim quotes, editable summary, AI-suggests row, triage controls, action bar.
// The other agent owns pages/InsightDetail.tsx. It does not yet export a reusable
// InsightDetailView, so per the build contract we render the detail inline here.

// The five queue buckets, in pipeline order, in words a founder gets instantly.
const BUCKETS: Array<{
  key: keyof QueueBuckets;
  label: string;
  tip: string;
}> = [
  {
    key: "to_review",
    label: "New from AI - needs your eyes",
    tip: "The AI pulled these from meetings. Nobody has checked them yet.",
  },
  {
    key: "to_finalize",
    label: "Triaged - needs final wording",
    tip: "Routed and owned, but the wording is not locked. Polish it, then finalize.",
  },
  {
    key: "to_ticket",
    label: "Ready for a ticket",
    tip: "Wording is locked. Draft a ticket so engineering can build it.",
  },
  {
    key: "to_confirm",
    label: "System thinks it shipped - confirm?",
    tip: "We found a release that looks like a match. Confirm it really shipped.",
  },
  {
    key: "to_email",
    label: "Shipped - tell the client",
    tip: "It shipped and is confirmed. Draft the note that closes the loop.",
  },
];

interface QueueBuckets {
  to_review: QueueItem[];
  to_finalize: QueueItem[];
  to_ticket: QueueItem[];
  to_confirm: QueueItem[];
  to_email: QueueItem[];
}

// Pipeline order of states for the stepper at the top of the detail panel.
const STEPPER: Array<{ state: string; label: string }> = [
  { state: "extracted", label: "Extracted" },
  { state: "triaged", label: "Triaged" },
  { state: "finalized", label: "Finalized" },
  { state: "ticketed", label: "Ticketed" },
  { state: "shipped", label: "Shipped" },
  { state: "client_notified", label: "Client told" },
];

function itemId(it: QueueItem): string {
  return it.insight_id || it.id || "";
}

export function Review() {
  const { user } = useAuth();
  const toast = useToast();

  const [buckets, setBuckets] = useState<QueueBuckets | null>(null);
  const [orgCounts, setOrgCounts] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadQueue = useCallback(
    (opts: { keepSelection?: boolean } = {}) => {
      setLoading(true);
      setError(null);
      api
        .queue()
        .then((q) => {
          const b: QueueBuckets = {
            to_review: q.to_review ?? [],
            to_finalize: q.to_finalize ?? [],
            to_ticket: q.to_ticket ?? [],
            to_confirm: q.to_confirm ?? [],
            to_email: q.to_email ?? [],
          };
          setBuckets(b);
          setOrgCounts(
            (q.org_counts as Record<string, unknown>) ||
              (q.org as Record<string, unknown>) ||
              null,
          );
          setLoading(false);
          // pick the first item unless we are explicitly preserving selection
          if (!opts.keepSelection) {
            const first = BUCKETS.flatMap((bk) => b[bk.key]).map(itemId).find(Boolean);
            setSelectedId((cur) => cur ?? first ?? null);
          }
        })
        .catch((e) => {
          setError(e);
          setLoading(false);
        });
    },
    [],
  );

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Flatten every bucket into one ordered list for j/k navigation.
  const flat = useMemo(() => {
    if (!buckets) return [];
    const out: Array<{ item: QueueItem; bucket: keyof QueueBuckets }> = [];
    for (const bk of BUCKETS) {
      for (const it of buckets[bk.key]) out.push({ item: it, bucket: bk.key });
    }
    return out;
  }, [buckets]);

  const selectedIndex = useMemo(
    () => flat.findIndex((f) => itemId(f.item) === selectedId),
    [flat, selectedId],
  );

  // j/k moves selection; Enter focuses the detail editor. Disabled while typing.
  const { index, setIndex } = useListSelection(
    flat.length,
    (i) => {
      const id = flat[i] ? itemId(flat[i]!.item) : "";
      if (id) {
        setSelectedId(id);
        // focus the editable summary in the detail pane
        window.requestAnimationFrame(() => {
          document.getElementById("review-body-editor")?.focus();
        });
      }
    },
    flat.length > 0,
  );

  // Two-way sync between selectedId (clicks) and index (j/k). Each direction
  // only fires when ITS OWN source actually changed since the last effect run.
  // Without the guards, the two effects read each other's stale value in the
  // same flush and ping-pong forever — a frame-rate re-render loop that leaves
  // the detail pane on skeletons and eventually kills the tab.
  const prevSelectedIndexRef = useRef(selectedIndex);
  useEffect(() => {
    const moved = selectedIndex !== prevSelectedIndexRef.current;
    prevSelectedIndexRef.current = selectedIndex;
    if (!moved) return;
    if (selectedIndex >= 0 && selectedIndex !== index) setIndex(selectedIndex);
  }, [selectedIndex, index, setIndex]);

  const prevIndexRef = useRef(index);
  useEffect(() => {
    const moved = index !== prevIndexRef.current;
    prevIndexRef.current = index;
    if (!moved) return;
    const f = flat[index];
    if (f) {
      const id = itemId(f.item);
      if (id && id !== selectedId) setSelectedId(id);
    }
  }, [index, flat, selectedId]);

  const totalCount = flat.length;

  // After a detail action (finalize/reject/etc.) reload the queue but keep looking
  // at the same item so the founder can see its new state, then advance if it left.
  const onDetailChanged = useCallback(
    (opts: { advance?: boolean } = {}) => {
      if (opts.advance) {
        const next = flat[selectedIndex + 1] || flat[selectedIndex - 1];
        setSelectedId(next ? itemId(next.item) : null);
        loadQueue({ keepSelection: true });
      } else {
        loadQueue({ keepSelection: true });
      }
    },
    [flat, selectedIndex, loadQueue],
  );

  return (
    <>
      <div className="head">
        <div className="row-between">
          <div>
            <h1>Review</h1>
            <p>Decide what each insight is and polish it before it moves.</p>
          </div>
          <div className="row">
            {totalCount > 0 && (
              <Tooltip content="Everything waiting on you across all five buckets.">
                <span className="mono tiny subtle">{totalCount} waiting</span>
              </Tooltip>
            )}
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => loadQueue({ keepSelection: true })}
              tooltip="Pull the latest queue from the server."
            >
              Refresh
            </Btn>
          </div>
        </div>
        {user?.role === "admin" && orgCounts && <OrgStrip counts={orgCounts} />}
      </div>

      <div className="split">
        <div className="queue" role="listbox" aria-label="Review queue">
          {loading && !buckets ? (
            <div style={{ padding: 16 }}>
              <Skeleton rows={8} />
            </div>
          ) : error ? (
            <div style={{ padding: 16 }}>
              <ErrorAlert error={error} onRetry={() => loadQueue()} />
            </div>
          ) : totalCount === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState
                title="Nothing waiting."
                body="When the AI pulls new insights from a meeting, they line up here for your review."
              />
            </div>
          ) : (
            BUCKETS.map((bk) => {
              const items = buckets ? buckets[bk.key] : [];
              if (items.length === 0) return null;
              return (
                <div key={bk.key}>
                  <div className="qgroup">
                    <Tooltip content={bk.tip}>
                      <span>{bk.label}</span>
                    </Tooltip>
                    <span className="n">{items.length}</span>
                  </div>
                  {items.map((it) => {
                    const id = itemId(it);
                    const handle =
                      it.handle || (id ? `INS-${id.slice(-6).toUpperCase()}` : "");
                    const itemType =
                      typeof it.item_type === "string" ? it.item_type : "";
                    return (
                      <button
                        type="button"
                        key={id || handle}
                        className={`lcard${id === selectedId ? " sel" : ""}`}
                        aria-selected={id === selectedId}
                        onClick={() => setSelectedId(id)}
                      >
                        <div className="t">{it.title || "Untitled insight"}</div>
                        <div className="meta">
                          {itemType && <ItemTypePill type={itemType} />}
                          {it.client_name && <span>{it.client_name}</span>}
                          <span>·</span>
                          <span className="mono">
                            {relativeAge(
                              typeof it.age_days === "number" ? it.age_days : undefined,
                            ) ||
                              ageOf(it.updated_at || it.created_at) ||
                              "today"}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className="detail corner">
          {selectedId ? (
            <DetailPanel
              key={selectedId}
              insightId={selectedId}
              onChanged={onDetailChanged}
              toast={toast}
            />
          ) : !loading ? (
            <EmptyState
              title="Pick something on the left."
              body="Select an insight to read what the client said, polish the wording, and route it."
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- admin org strip

function OrgStrip({ counts }: { counts: Record<string, unknown> }) {
  const entries = Object.entries(counts).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return null;
  return (
    <div className="org-strip">
      <Tooltip content="Across the whole team, not just your own queue.">
        <span className="lbl">Org-wide</span>
      </Tooltip>
      {entries.map(([k, v]) => (
        <span key={k} className="org-stat">
          <span className="mono num">{String(v)}</span>
          <span className="subtle tiny">{k.replaceAll("_", " ")}</span>
        </span>
      ))}
      <style>{`
        .org-strip { display:flex; align-items:center; gap:14px; margin-top:10px; flex-wrap:wrap; }
        .org-stat { display:inline-flex; align-items:baseline; gap:5px; }
        .org-stat .num { font-size:13px; color:var(--ink); }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------- detail panel (inline detail view)

type ToastApi = ReturnType<typeof useToast>;

function DetailPanel({
  insightId,
  onChanged,
  toast,
}: {
  insightId: string;
  onChanged: (opts?: { advance?: boolean }) => void;
  toast: ToastApi;
}) {
  const navigate = useNavigate();

  const [detail, setDetail] = useState<InsightDetailData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  // local editable state
  const [bodyText, setBodyText] = useState("");
  const [version, setVersion] = useState(0);
  const [track, setTrack] = useState("");
  const [assignee, setAssignee] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Uncontrolled editor: we seed its text once per load and read it on input, so the
  // caret never jumps. bodyText holds the latest value for save + dirty tracking.
  const editorRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getInsight(insightId)
      .then((d) => {
        setDetail(d);
        const ins = d.insight;
        setBodyText(ins?.body_current ?? ins?.body_original ?? "");
        setVersion(typeof ins?.version === "number" ? ins.version : 0);
        setTrack((ins?.track as string) || "");
        setAssignee((ins?.assignee_user_id as string) || "");
        setDirty(false);
        setLoading(false);
      })
      .catch((e) => {
        setError(e);
        setLoading(false);
      });
  }, [insightId]);

  useEffect(() => {
    load();
  }, [load]);

  // load the assignable people once for the owner dropdown (admins see the full list;
  // members may get a 403, in which case we just keep whatever the insight already has)
  useEffect(() => {
    let live = true;
    api
      .listUsers()
      .then((us) => {
        if (live) setUsers(us.filter((u) => !u.revoked_at));
      })
      .catch(() => {
        /* not an admin or list unavailable; owner select falls back to current value */
      });
    return () => {
      live = false;
    };
  }, []);

  const ins = detail?.insight;
  const state = (ins?.state as string) || "extracted";

  // Seed the uncontrolled editor when fresh data arrives, but never clobber what the
  // user is typing. Only writes the DOM when there are no unsaved edits.
  useEffect(() => {
    const el = editorRef.current;
    if (!el || dirty) return;
    if (el.textContent !== bodyText) el.textContent = bodyText;
  }, [bodyText, dirty, detail]);

  const handle =
    detail?.handle || ins?.handle || `INS-${insightId.slice(-6).toUpperCase()}`;
  const mentions: Mention[] = detail?.mentions ?? [];
  const tags = (detail?.tags ?? [])
    .map((t) => (typeof t === "string" ? t : t.tag || t.name || ""))
    .filter(Boolean) as string[];

  // The AI's first guess, if the server stored one.
  const aiSuggest = useMemo(() => {
    const raw = ins?.ai_suggested_json;
    if (!raw) return null;
    let obj: Record<string, unknown> | null = null;
    if (typeof raw === "string") {
      try {
        obj = JSON.parse(raw);
      } catch {
        obj = null;
      }
    } else if (typeof raw === "object") {
      obj = raw as Record<string, unknown>;
    }
    if (!obj) return null;
    const aiTrack = typeof obj.track === "string" ? obj.track : undefined;
    const aiAssignee =
      typeof obj.assignee_user_id === "string" ? obj.assignee_user_id : undefined;
    if (!aiTrack && !aiAssignee) return null;
    return { track: aiTrack, assignee_user_id: aiAssignee };
  }, [ins?.ai_suggested_json]);

  const aiAssigneeName = useMemo(() => {
    if (!aiSuggest?.assignee_user_id) return undefined;
    return users.find((u) => u.id === aiSuggest.assignee_user_id)?.name;
  }, [aiSuggest, users]);

  function applyAiSuggest() {
    if (!aiSuggest) return;
    if (aiSuggest.track) setTrack(aiSuggest.track);
    if (aiSuggest.assignee_user_id) setAssignee(aiSuggest.assignee_user_id);
    toast.push("Applied the AI's suggestion. Review it, then route or finalize.", "info");
  }

  // ---- actions

  async function saveBodyIfDirty(): Promise<boolean> {
    if (!dirty) return true;
    try {
      const r = await api.saveBody(insightId, bodyText, version);
      const newVersion = typeof r?.version === "number" ? r.version : version + 1;
      setVersion(newVersion);
      setDirty(false);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const cur =
          e.data && typeof e.data === "object"
            ? (e.data as Record<string, unknown>).current_version
            : undefined;
        toast.push(
          "Someone else edited this while you were typing. Reloading the latest wording.",
          "warning",
        );
        if (typeof cur === "number") setVersion(cur);
        load();
        return false;
      }
      toast.push(e instanceof Error ? e.message : "Could not save the wording.", "critical");
      return false;
    }
  }

  async function onSave() {
    setBusy("save");
    const ok = await saveBodyIfDirty();
    setBusy(null);
    if (ok && dirty === false) toast.push("Saved.", "success");
  }

  async function onTriage() {
    setBusy("triage");
    try {
      if (!track) {
        toast.push("Pick a track first so we know where this goes.", "warning");
        setBusy(null);
        return;
      }
      await api.triage(insightId, {
        track,
        assignee_user_id: assignee || undefined,
        tags: tags.length ? tags : undefined,
      });
      toast.push("Routed. It now needs final wording.", "success");
      load();
      onChanged();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not route this.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function onFinalize() {
    setBusy("finalize");
    try {
      const ok = await saveBodyIfDirty();
      if (!ok) {
        setBusy(null);
        return;
      }
      await api.finalize(insightId);
      toast.push("Wording locked. It can now become a ticket.", "success");
      load();
      onChanged();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not finalize this.", "critical");
    } finally {
      setBusy(null);
    }
  }

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  async function onReject() {
    if (!rejectReason.trim()) {
      toast.push("Add a short reason so the record makes sense later.", "warning");
      return;
    }
    setBusy("reject");
    try {
      await api.rejectInsight(insightId, rejectReason.trim());
      toast.push("Rejected. It stays on record but goes no further.", "info");
      setRejecting(false);
      setRejectReason("");
      onChanged({ advance: true });
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not reject this.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function onDraftTicket() {
    setBusy("ticket");
    try {
      const ok = await saveBodyIfDirty();
      if (!ok) {
        setBusy(null);
        return;
      }
      await api.generateTicketDraft(insightId);
      toast.push("Drafted a ticket. Open the insight to raise it.", "success");
      load();
      onChanged();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not draft a ticket.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function onDraftEmail() {
    setBusy("email");
    try {
      await api.generateEmailDrafts(insightId);
      toast.push("Drafted the note to the client. Open the insight to send it.", "success");
      load();
      onChanged();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not draft the note.", "critical");
    } finally {
      setBusy(null);
    }
  }

  async function onConfirmShipped() {
    setBusy("confirm");
    try {
      const ev = detail?.evidence?.find((e) => (e.status || "").toLowerCase() === "proposed");
      if (ev?.id) {
        await api.confirmEvidence(ev.id);
        toast.push("Confirmed it shipped. Now tell the client.", "success");
      } else {
        toast.push("No proof to confirm. Open the insight to add some.", "warning");
      }
      load();
      onChanged();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not confirm this.", "critical");
    } finally {
      setBusy(null);
    }
  }

  if (loading && !detail) {
    return <Skeleton rows={9} />;
  }
  if (error) {
    return <ErrorAlert error={error} onRetry={load} />;
  }
  if (!ins) {
    return (
      <EmptyState
        title="This insight is no longer here."
        body="It may have been merged or removed. Pick another from the queue."
      />
    );
  }

  // which actions matter at this state
  const isExtractedOrTriaged = state === "extracted" || state === "triaged";
  const isFinalized = state === "finalized";
  const isTicketed = state === "ticketed";
  const isShipped = state === "shipped";
  const canEditBody = isExtractedOrTriaged;

  const meetingDate = mentions[0]?.meeting_date || (ins.created_at as string | undefined);
  const meetingSeq = mentions[0]?.meeting_seq ?? mentions[0]?.seq;
  const clientName = ins.client_name || mentions[0]?.client_name;

  return (
    <div className="stack" style={{ paddingRight: 8 }}>
      {/* state stepper */}
      <div className="states">
        {STEPPER.map((s, i) => {
          const curIdx = STEPPER.findIndex((x) => x.state === state);
          const cls = s.state === state ? "st on" : i < curIdx ? "st done" : "st";
          return (
            <Tooltip key={s.state} title={s.label} content={stepperTip(s.state)}>
              <span className={cls}>{s.label}</span>
            </Tooltip>
          );
        })}
        {(state === "rejected" || state === "closed" || state === "merged") && (
          <StatePill state={state} />
        )}
      </div>

      <div>
        <h2 className="htitle" style={{ fontSize: 18, marginBottom: 4 }}>
          {ins.title || "Untitled insight"}
        </h2>
        <div className="hsub mono subtle" style={{ fontSize: 11.5 }}>
          {handle}
          {clientName ? ` · ${clientName}` : ""}
          {meetingSeq ? ` · meeting ${meetingSeq}` : ""}
          {meetingDate ? ` · ${formatDate(meetingDate)}` : ""}
        </div>
      </div>

      {/* verbatim quotes */}
      <div>
        <div className="dlbl">What the client actually said</div>
        {mentions.length === 0 ? (
          <p className="muted small">No direct quote was captured for this one.</p>
        ) : (
          <div className="stack-sm">
            {mentions.map((m, i) => (
              <div className="quote" key={m.id || i}>
                {m.quote || "(no quote text)"}
                <span className="by">
                  {[
                    m.speaker || "Unknown speaker",
                    m.client_name,
                    m.meeting_seq ? `meeting ${m.meeting_seq}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* editable summary */}
      <div>
        <div className="dlbl">
          {canEditBody ? "Summary (edit before you finalize)" : "Summary"}
        </div>
        <div
          id="review-body-editor"
          ref={editorRef}
          className="bodybox"
          contentEditable={canEditBody}
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label="Insight summary"
          tabIndex={0}
          onInput={(e) => {
            setBodyText(e.currentTarget.textContent || "");
            setDirty(true);
          }}
          style={canEditBody ? undefined : { opacity: 0.85 }}
        />
        {canEditBody && (
          <div className="row" style={{ marginTop: 8 }}>
            <Btn
              size="sm"
              onClick={onSave}
              disabled={!dirty || busy !== null}
              tooltip="Save the wording without locking it. You can keep editing afterwards."
            >
              {busy === "save" ? "Saving" : "Save draft"}
            </Btn>
            {dirty && <span className="tiny subtle">unsaved changes</span>}
          </div>
        )}
      </div>

      {/* AI suggestion row */}
      {aiSuggest && isExtractedOrTriaged && (
        <div className="aibox">
          <b>AI suggests:</b>{" "}
          {aiSuggest.track ? `track ${trackLabel(aiSuggest.track).toLowerCase()}` : ""}
          {aiSuggest.track && aiSuggest.assignee_user_id ? " · " : ""}
          {aiSuggest.assignee_user_id
            ? `owner ${aiAssigneeName || "a teammate"}`
            : ""}{" "}
          <Tooltip content="Copy these picks into the route fields below. You can still change them.">
            <button type="button" className="ai-apply" onClick={applyAiSuggest}>
              Apply &rarr;
            </button>
          </Tooltip>
          <style>{`
            .ai-apply { background:none; border:none; color:var(--accent); cursor:pointer;
              font-family:var(--font); font-size:11.5px; padding:0; }
            .ai-apply:hover { text-decoration:underline; }
          `}</style>
        </div>
      )}

      {/* triage controls (only meaningful before finalize) */}
      {isExtractedOrTriaged && (
        <div>
          <div className="dlbl">Route it</div>
          <div className="triage-row">
            <label className="field">
              <span className="lbl">Track</span>
              <Tooltip content="Which team handles this. Engineering builds it; the others polish, market, or note it.">
                <select
                  className="ctrl"
                  value={track}
                  onChange={(e) => setTrack(e.target.value)}
                  aria-label="Track"
                >
                  <option value="">Pick a track</option>
                  {TRACKS.map((t) => (
                    <option key={t} value={t}>
                      {trackLabel(t)}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </label>
            <label className="field">
              <span className="lbl">Owner</span>
              <Tooltip content="Who is accountable for moving this forward.">
                <select
                  className="ctrl"
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                  aria-label="Owner"
                >
                  <option value="">Pick a person</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name || u.email}
                    </option>
                  ))}
                  {/* keep the current owner selectable even if not in the list */}
                  {assignee && !users.some((u) => u.id === assignee) && (
                    <option value={assignee}>
                      {(ins.assignee_name as string) || "Current owner"}
                    </option>
                  )}
                </select>
              </Tooltip>
            </label>
            {tags.length > 0 && (
              <div className="field">
                <span className="lbl">Tags</span>
                <div className="chips">
                  {tags.map((t) => (
                    <span className="chip" key={t}>
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* reject reason inline form */}
      {rejecting && (
        <div className="card stack-sm">
          <label className="field">
            <span className="lbl">Why reject this?</span>
            <textarea
              className="ctrl"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="A short reason. It stays on the record."
              rows={2}
              autoFocus
            />
          </label>
          <div className="row">
            <Btn
              variant="danger"
              size="sm"
              onClick={onReject}
              disabled={busy !== null}
              tooltip="Mark it wrong or not useful. It stops here but stays on record."
            >
              {busy === "reject" ? "Rejecting" : "Confirm reject"}
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              onClick={() => {
                setRejecting(false);
                setRejectReason("");
              }}
            >
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {/* action bar - changes with the state */}
      <div className="actions">
        {isExtractedOrTriaged && (
          <>
            <Btn
              variant="primary"
              onClick={state === "triaged" ? onFinalize : onTriage}
              disabled={busy !== null}
              tooltip={
                state === "triaged"
                  ? "Locks the wording. After this it can become a ticket or be marked shipped."
                  : "Save the track and owner. The insight moves to needs-final-wording."
              }
            >
              {state === "triaged"
                ? busy === "finalize"
                  ? "Finalizing"
                  : "Finalize wording"
                : busy === "triage"
                  ? "Routing"
                  : "Route it"}
            </Btn>
            {state === "triaged" && (
              <Btn
                onClick={onTriage}
                disabled={busy !== null}
                tooltip="Update the track, owner, or tags without finalizing yet."
              >
                {busy === "triage" ? "Saving" : "Save routing"}
              </Btn>
            )}
            {!rejecting && (
              <Btn
                variant="ghost"
                className="danger"
                onClick={() => setRejecting(true)}
                disabled={busy !== null}
                tooltip="Wrong or not useful. It stays on record but stops here."
              >
                Reject
              </Btn>
            )}
          </>
        )}

        {isFinalized && (
          <Btn
            variant="primary"
            onClick={onDraftTicket}
            disabled={busy !== null}
            tooltip="Draft a GitHub issue from this. You choose where to create it on the insight page."
          >
            {busy === "ticket" ? "Drafting" : "Draft ticket"}
          </Btn>
        )}

        {isTicketed && (
          <span className="muted small">
            A ticket is drafted. Open the insight to raise it with engineering.
          </span>
        )}

        {isShipped && (
          <>
            <Btn
              variant="primary"
              onClick={onConfirmShipped}
              disabled={busy !== null}
              tooltip="Confirm the matched release really shipped this ask."
            >
              {busy === "confirm" ? "Confirming" : "Confirm it shipped"}
            </Btn>
            <Btn
              onClick={onDraftEmail}
              disabled={busy !== null}
              tooltip="Draft the note that tells the client it is live."
            >
              {busy === "email" ? "Drafting" : "Draft client note"}
            </Btn>
          </>
        )}

        <div className="spacer" />
        <Btn
          variant="ghost"
          onClick={() => navigate(`/insights/${encodeURIComponent(insightId)}`)}
          tooltip="See the full history: every quote, the ticket, the proof, and the timeline."
        >
          Open full record &rarr;
        </Btn>
      </div>

      <style>{`
        .triage-row { display:flex; gap:18px; flex-wrap:wrap; }
        .triage-row .field { min-width:160px; }
        .actions { display:flex; gap:8px; align-items:center; margin-top:8px;
          padding-top:16px; border-top:1px solid var(--line-soft); flex-wrap:wrap; }
        .hsub { margin-bottom: 2px; }
      `}</style>
    </div>
  );
}

function stepperTip(stateKey: string): string {
  switch (stateKey) {
    case "extracted":
      return "The AI pulled this from a meeting. Nobody has checked it yet.";
    case "triaged":
      return "Routed and owned. The wording is not locked yet.";
    case "finalized":
      return "The wording is locked. It can become a ticket or be marked shipped.";
    case "ticketed":
      return "A ticket has been drafted or raised for engineering.";
    case "shipped":
      return "Engineering shipped it. Confirm it, then tell the client.";
    case "client_notified":
      return "We told the client it shipped. The loop is closed.";
    default:
      return stateLabel(stateKey);
  }
}
