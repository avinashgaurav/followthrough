import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, TRACKS, insightHandle } from "../api";
import type { InsightDetail as InsightDetailData, Mention, QueueItem, User } from "../api";
import { useListSelection } from "../components/shortcuts";
import {
  Btn,
  EmptyState,
  ErrorAlert,
  Help,
  ItemTypePill,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import { ageOf, formatDate, nextStep, relativeAge, trackLabel, insightTitle } from "../format";
import { StateStepper } from "./InsightDetail";

// Job: decide what each insight is and polish it before it moves.
// Two layouts over the same queue + selection state (persisted in ie_review_mode):
//   Focus (default) = one insight at a time in a centered card, with a position
//           line ("Insight 3 of 12 · bucket") and Previous/Next. The comprehension
//           fix: no wall of cards, just the next decision.
//   All   = the original two-pane triage screen:
//     left  = GET /api/queue rendered as plain-language buckets, j/k to move, Enter to focus
//     right = a queue-tuned detail panel (loaded via api.getInsight) with the shared
//           StateStepper, verbatim quotes, editable summary, AI-suggests row, triage
//           controls, action bar. Kept inline (not InsightDetailView embedded) because
//           the queue flow needs advance-on-reject, queue reloads after every action,
//           and the #review-body-editor keyboard-focus target. Labels, vocabulary and
//           editor semantics are kept identical to InsightDetail so the two surfaces
//           read as one.
// j/k + Enter work in both modes (useListSelection drives one shared index), and
// the selection survives toggling modes because it lives up here, not per-layout.

// The five queue buckets, in pipeline order, in the one pipeline vocabulary
// (Found / Routed / Locked / Ticket raised / Shipped / Client told).
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
    label: "Routed - needs final wording",
    tip: "Routed and owned, but the wording is not locked. Polish it, then finalize.",
  },
  {
    key: "to_ticket",
    label: "Locked - ready for a ticket",
    tip: "The wording is locked. Draft a ticket so engineering can build it.",
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

function itemId(it: QueueItem): string {
  return it.insight_id || it.id || "";
}

// Meeting fields on QueueItem are optional and loosely typed ([k: string]: unknown).
// Read them defensively; a null return means "no meeting info, do not sub-group".
function meetingInfoOf(it: QueueItem): { key: string; seq?: string; date?: string; title?: string } | null {
  const rawSeq = it.meeting_seq ?? it.seq;
  const seq =
    typeof rawSeq === "number"
      ? String(rawSeq)
      : typeof rawSeq === "string" && rawSeq.trim()
        ? rawSeq.trim()
        : undefined;
  const date = typeof it.meeting_date === "string" && it.meeting_date ? it.meeting_date : undefined;
  const title = typeof it.meeting_title === "string" && it.meeting_title.trim() ? it.meeting_title.trim() : undefined;
  if (!seq && !date && !title) return null;
  return { key: `${seq ?? ""}|${date ?? ""}|${title ?? ""}`, seq, date, title };
}

export function Review() {
  const toast = useToast();

  const [buckets, setBuckets] = useState<QueueBuckets | null>(null);
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
            <div className="row gap-8">
              <h1>Review</h1>
              <Help
                title="How review works"
                content="Capture brings meetings in and the AI finds the insights. Here you review, polish, and route them. Locked insights become tickets, Confirm shipped closes the loop, and Speed shows the pace. Nothing reaches a client without you."
              />
            </div>
            <p>Decide what each insight is and polish it before it moves.</p>
          </div>
          <div className="row">
            {totalCount > 0 && (
              <Tooltip content="Everything waiting on you, across every stage.">
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
      </div>

      <div className="split">
        <div className="queue" role="listbox" aria-label="Review queue">
          {loading && !buckets ? (
            <div className="p-16">
              <Skeleton rows={8} />
            </div>
          ) : error ? (
            <div className="p-16">
              <ErrorAlert error={error} onRetry={() => loadQueue()} />
            </div>
          ) : totalCount === 0 ? (
            <div className="p-16">
              <EmptyState
                title="Nothing waiting."
                body="When the AI pulls new insights from a meeting, they line up here for your review."
              />
            </div>
          ) : (
            BUCKETS.map((bk) => {
              const items = buckets ? buckets[bk.key] : [];
              if (items.length === 0) return null;
              // Big buckets become a wall of look-alike cards. Group by client so
              // the eye can skip whole accounts instead of reading every title.
              const byClient = new Map<string, QueueItem[]>();
              for (const it of items) {
                const c = it.client_name || "Unknown client";
                if (!byClient.has(c)) byClient.set(c, []);
                byClient.get(c)!.push(it);
              }
              const grouped = items.length > 6 && byClient.size > 1;
              const renderCard = (it: QueueItem, showClient: boolean) => {
                const id = itemId(it);
                const itemType = typeof it.item_type === "string" ? it.item_type : "";
                return (
                  <button
                    type="button"
                    role="option"
                    key={id || insightHandle(id)}
                    className={`lcard${id === selectedId ? " sel" : ""}`}
                    aria-selected={id === selectedId}
                    onClick={() => setSelectedId(id)}
                  >
                    <div className="t">{insightTitle(it.title) || "Untitled insight"}</div>
                    {/* lead with client + date; the INS- handle lives in the detail pane only */}
                    <div className="meta">
                      {showClient && it.client_name && (
                        <>
                          <span>{it.client_name}</span>
                          <span>·</span>
                        </>
                      )}
                      <span className="mono">
                        {relativeAge(
                          typeof it.age_days === "number" ? it.age_days : undefined,
                        ) ||
                          ageOf(it.updated_at || it.created_at) ||
                          "today"}
                      </span>
                      {itemType && <ItemTypePill type={itemType} />}
                    </div>
                  </button>
                );
              };
              // Inside one client, more than 8 items is a wall again. Sub-group
              // those by meeting so a long account scans in meeting-sized
              // chunks. Skips quietly when items carry no meeting fields.
              const renderClientItems = (clientItems: QueueItem[]) => {
                if (clientItems.length <= 8) return clientItems.map((it) => renderCard(it, false));
                const byMeeting = new Map<string, { label: string; items: QueueItem[] }>();
                let withMeeting = 0;
                for (const it of clientItems) {
                  const info = meetingInfoOf(it);
                  if (info) withMeeting++;
                  const key = info ? info.key : "__no_meeting__";
                  if (!byMeeting.has(key)) {
                    const label = info
                      ? [
                          info.seq ? `Meeting ${info.seq}` : info.title || "Meeting",
                          info.date ? formatDate(info.date) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : "";
                    byMeeting.set(key, { label, items: [] });
                  }
                  byMeeting.get(key)!.items.push(it);
                }
                // No meeting data, or everything in one meeting: keep the flat list.
                if (withMeeting === 0 || byMeeting.size < 2) {
                  return clientItems.map((it) => renderCard(it, false));
                }
                return [...byMeeting.entries()].map(([key, g]) => (
                  <div key={key}>
                    {g.label && (
                      <div className="qmeeting">
                        <span>{g.label}</span>
                        <span className="n">{g.items.length}</span>
                      </div>
                    )}
                    {g.items.map((it) => renderCard(it, false))}
                  </div>
                ));
              };
              return (
                <div key={bk.key}>
                  <div className="qgroup">
                    <Tooltip content={bk.tip}>
                      <span>{bk.label}</span>
                    </Tooltip>
                    <span className="n">{items.length}</span>
                  </div>
                  {grouped
                    ? [...byClient.entries()].map(([client, clientItems]) => (
                        <div key={client}>
                          <div className="qclient">
                            <span>{client}</span>
                            <span className="n">{clientItems.length}</span>
                          </div>
                          {renderClientItems(clientItems)}
                        </div>
                      ))
                    : items.map((it) => renderCard(it, true))}
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

      {/* page-scoped: meeting sub-headers nested under .qclient groups. Not
          sticky on purpose; stacking two sticky headers makes them overlap. */}
      <style>{`
        .qmeeting {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 6px 16px 2px 24px;
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--ink-subtle);
          background: var(--canvas);
        }
        .qmeeting .n {
          font-family: var(--mono);
          font-size: 9px;
          color: var(--ink-subtle);
        }
      `}</style>
    </>
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

  // local editable state. Same editor semantics as InsightDetail: a controlled
  // textarea, dirty = current text differs from what the server has.
  const [bodyText, setBodyText] = useState("");
  const [serverBody, setServerBody] = useState("");
  const [version, setVersion] = useState(0);
  const [track, setTrack] = useState("");
  const [assignee, setAssignee] = useState("");
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .getInsight(insightId)
      .then((d) => {
        setDetail(d);
        const ins = d.insight;
        const body = ins?.body_current ?? ins?.body_original ?? "";
        setBodyText(body);
        setServerBody(body);
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
        if (live) setUsers(us.filter((u) => !u.disabled_at));
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

  const handle =
    detail?.handle || ins?.handle || insightHandle(insightId);
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

  // One properly-cased sentence for the strip (same shape as InsightDetail's).
  const aiSuggestLine = useMemo(() => {
    if (!aiSuggest) return "";
    const owner = aiSuggest.assignee_user_id ? aiAssigneeName || "a teammate" : undefined;
    // "Other" with no owner is noise, not a suggestion; showing it erodes trust.
    if (aiSuggest.track === "other" && !owner) return "";
    if (aiSuggest.track && owner) {
      return `AI suggests routing this to ${trackLabel(aiSuggest.track)}, owned by ${owner}.`;
    }
    if (aiSuggest.track) return `AI suggests routing this to ${trackLabel(aiSuggest.track)}.`;
    if (owner) return `AI suggests ${owner} as the owner.`;
    return "";
  }, [aiSuggest, aiAssigneeName]);

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
      setServerBody(bodyText);
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
    // `dirty` from this render is a stale closure after the save flips it, so the
    // success toast keys off the save result alone (the button only enables when dirty).
    if (ok) toast.push("Saved.", "success");
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

  // Inbox shortcut: 'r' opens the reject form for the selected insight (only
  // where Reject is a legal move, i.e. before it has been finalized). The form's
  // textarea autofocuses, so the next keystrokes go to the reason, not here.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const el = e.target;
      if (el instanceof HTMLElement) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return;
      }
      if (e.key !== "r" && e.key !== "R") return;
      const canReject = state === "extracted" || state === "triaged";
      if (!canReject || rejecting || busy !== null) return;
      e.preventDefault();
      setRejecting(true);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, rejecting, busy]);

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

  const step = nextStep(state);

  return (
    <div className="stack" style={{ paddingRight: 8 }}>
      {/* pipeline spine: same stepper InsightDetail uses, so the inbox and the
          full record read as one. The current stage is the only thing in amber. */}
      <StateStepper state={state} />

      {/* the one legal next move, in plain words, directly under the spine */}
      {step && (
        <div className="nextstep">
          <span className="tick" aria-hidden="true" />
          <span className="lead">Next</span>
          <span>
            <span className="verb">{step.verb}.</span> <span className="hint">{step.hint}</span>
          </span>
        </div>
      )}

      {state === "closed" && <StatePill state="closed" />}

      <div>
        <h2 className="htitle" style={{ fontSize: 18, marginBottom: 4 }}>
          {insightTitle(ins.title) || "Untitled insight"}
        </h2>
        <div className="hsub mono subtle" style={{ fontSize: 11.5, marginBottom: 2 }}>
          {handle}
          {clientName ? ` · ${clientName}` : ""}
          {meetingSeq ? ` · meeting ${meetingSeq}` : ""}
          {meetingDate ? ` · ${formatDate(meetingDate)}` : ""}
        </div>
        {(ins.side || ins.sentiment || ins.intent) && (
          <p className="tiny muted" style={{ margin: "4px 0 0" }}>
            {ins.side && ins.side !== "unknown" && (
              <span>From: {ins.side === "client" ? "client" : "our team"}</span>
            )}
            {ins.sentiment ? ` · sentiment: ${ins.sentiment}` : ""}
            {ins.intent ? ` · intent: ${ins.intent}` : ""}
          </p>
        )}
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

      {/* editable summary: same labels and editor semantics as InsightDetail */}
      <div>
        <div className="dlbl">
          {canEditBody ? "Summary (edit before you finalize)" : "Final wording"}
        </div>
        <textarea
          id="review-body-editor"
          className="ctrl"
          style={{ minHeight: 130 }}
          value={bodyText}
          disabled={!canEditBody || busy === "save"}
          aria-label="Insight summary"
          onChange={(e) => {
            setBodyText(e.target.value);
            setDirty(e.target.value !== serverBody);
          }}
          placeholder="Write the polished summary the rest of the team and the client will see."
        />
        {canEditBody && (
          <div className="row mt-8">
            <Tooltip
              content={
                !dirty
                  ? "Nothing to save yet. Edit the summary first."
                  : "Save this wording. Everything downstream uses what you save here."
              }
            >
              {/* span wrapper so the tooltip still shows while the button is disabled */}
              <span>
                <Btn size="sm" onClick={onSave} disabled={!dirty || busy !== null}>
                  {busy === "save" ? "Saving" : "Save wording"}
                </Btn>
              </span>
            </Tooltip>
            {dirty && <span className="tiny subtle">Unsaved changes.</span>}
          </div>
        )}
      </div>

      {/* AI suggestion row */}
      {aiSuggest && aiSuggestLine && isExtractedOrTriaged && (
        <div className="aibox">
          {aiSuggestLine}{" "}
          <Tooltip content="Copy these picks into the route fields below. You can still change them.">
            <button type="button" className="ai-apply" onClick={applyAiSuggest}>
              Apply suggestion
            </button>
          </Tooltip>
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
            <Tooltip
              content={
                state === "triaged"
                  ? "Locks the wording. After this it can become a ticket or be marked shipped."
                  : "Save the track and owner. The insight moves to Routed - needs final wording."
              }
            >
              {/* span wrapper so the tooltip still shows while the button is disabled */}
              <span>
                <Btn
                  variant="primary"
                  onClick={state === "triaged" ? onFinalize : onTriage}
                  disabled={busy !== null}
                >
                  {state === "triaged"
                    ? busy === "finalize"
                      ? "Finalizing"
                      : "Finalize wording"
                    : busy === "triage"
                      ? "Routing"
                      : "Route it"}
                </Btn>
              </span>
            </Tooltip>
            {state === "triaged" && (
              <span className="helper">
                Locks the wording - you cannot edit the summary afterwards.
              </span>
            )}
            {state === "triaged" && (
              <Tooltip content="Update the track, owner, or tags without finalizing yet.">
                {/* span wrapper so the tooltip still shows while the button is disabled */}
                <span>
                  <Btn onClick={onTriage} disabled={busy !== null}>
                    {busy === "triage" ? "Saving" : "Save routing"}
                  </Btn>
                </span>
              </Tooltip>
            )}
            {!rejecting && (
              <Btn
                variant="ghost"
                className="danger"
                onClick={() => setRejecting(true)}
                disabled={busy !== null}
                tooltip="Closes it as not useful. It stays on record; the client never hears about it."
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
              tooltip="Confirm the matched release really shipped this insight."
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
        {/* merge, close, tickets, and proof all live on the full record */}
        <Btn
          variant="ghost"
          onClick={() => navigate(`/insights/${encodeURIComponent(insightId)}`)}
          tooltip="See the full history: every quote, the ticket, the proof, and the timeline."
        >
          Open full record &rarr;
        </Btn>
      </div>
    </div>
  );
}

