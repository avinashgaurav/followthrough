import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, asArray, STATES, TRACKS } from "../api";
import type { Client, Insight, Meeting as MeetingRow, User } from "../api";
import { useAuth } from "../auth";
import {
  Btn,
  ConfirmModal,
  EmptyState,
  ErrorAlert,
  ItemTypePill,
  Markdown,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import {
  formatDate,
  insightTitle,
  meetingStatusLabel,
  stateLabel,
  titleCase,
  trackLabel,
} from "../format";

// Job: one meeting, everything that came out of it. Humans remember meetings,
// not insight IDs, so this is the meeting's real page.
// Data: api.getMeeting(id) -> { meeting, has_transcript, transcripts, insights },
// api.getAnalysis(id) for the brief, api.listInsights({client_id}) filtered by
// meeting_id for the richer insight rows (the backend list has no meeting filter).

interface MeetingDetailData {
  meeting: MeetingRow;
  hasTranscript: boolean;
  /** Insight rows embedded in the detail response: id, title, state only. */
  inlineInsights: Insight[];
}

/** getMeeting returns a loose object; pull the pieces out defensively. */
function shapeDetail(raw: Record<string, unknown>): MeetingDetailData {
  const meeting = (raw.meeting as MeetingRow) ?? (raw as MeetingRow);
  const transcripts = asArray<Record<string, unknown>>(raw.transcripts);
  return {
    meeting,
    hasTranscript: Boolean(raw.has_transcript ?? transcripts.length > 0),
    inlineInsights: asArray<Insight>(raw.insights),
  };
}

function meetingSeq(m: MeetingRow): number | null {
  const v = m.seq ?? m.seq_no;
  return typeof v === "number" ? v : null;
}

/** The detail response is authoritative for which insights belong to this
 *  meeting; the list response carries the richer fields (item type, track).
 *  Merge the two so the page works even if one of them is behind. */
function mergeInsights(inline: Insight[], listed: Insight[], meetingId: string): Insight[] {
  const fromList = listed.filter((r) => r.meeting_id === meetingId);
  const byId = new Map(fromList.map((r) => [r.id, r]));
  const out: Insight[] = [];
  const seen = new Set<string>();
  for (const row of inline) {
    if (!row.id) continue;
    seen.add(row.id);
    out.push({ ...row, ...(byId.get(row.id) ?? {}) });
  }
  for (const r of fromList) {
    if (r.id && !seen.has(r.id)) out.push(r);
  }
  return out;
}

export function Meeting() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();

  const [detail, setDetail] = useState<MeetingDetailData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [listed, setListed] = useState<Insight[] | null>(null);
  const [clientName, setClientName] = useState<string | null>(null);
  const [brief, setBrief] = useState<string | null>(null);
  const [briefFailed, setBriefFailed] = useState(false);

  const [extracting, setExtracting] = useState(false);

  // Brief-first review: route or reject every extracted insight in one pass.
  const [users, setUsers] = useState<User[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [routeTrack, setRouteTrack] = useState("");
  const [routeOwner, setRouteOwner] = useState("");
  const [bulkBusy, setBulkBusy] = useState<"route" | "reject" | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);

  const loadDetail = useCallback(async () => {
    setError(null);
    setNotFound(false);
    try {
      const raw = await api.getMeeting(id);
      setDetail(shapeDetail(raw));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e);
    }
  }, [id]);

  const loadBrief = useCallback(async () => {
    setBriefFailed(false);
    try {
      const r = await api.getAnalysis(id);
      setBrief(r.markdown ?? "");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setBrief("");
      else setBriefFailed(true);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void loadDetail();
    void loadBrief();
  }, [id, loadDetail, loadBrief]);

  // Secondary fetches need the client id off the meeting row.
  const clientId = detail?.meeting.client_id ? String(detail.meeting.client_id) : "";

  useEffect(() => {
    if (!clientId) return;
    let alive = true;
    api
      .listInsights({ client_id: clientId })
      .then((rows) => {
        if (alive) setListed(rows);
      })
      .catch(() => {
        // The inline rows from the detail response still render; just thinner.
        if (alive) setListed([]);
      });
    api
      .getClient(clientId)
      .then((raw) => {
        const c = (raw?.client as Client | undefined) ?? (raw as Client | undefined);
        if (alive && c?.name) setClientName(c.name);
      })
      .catch(() => {
        // Name stays blank; the Open client button still works.
      });
    return () => {
      alive = false;
    };
  }, [clientId]);

  // Assignable people for the owner select. Members may get a 403; the select
  // then falls back to just the current user.
  useEffect(() => {
    let alive = true;
    api
      .listUsers()
      .then((us) => {
        if (alive) setUsers(us.filter((u) => !u.disabled_at));
      })
      .catch(() => {
        // Not an admin or list unavailable; owner options fall back to me.
      });
    return () => {
      alive = false;
    };
  }, []);

  // Default the batch owner to whoever is reviewing, once auth resolves.
  useEffect(() => {
    if (user?.id) setRouteOwner((cur) => cur || user.id);
  }, [user?.id]);

  const insights = useMemo(
    () => (detail ? mergeInsights(detail.inlineInsights, listed ?? [], id) : []),
    [detail, listed, id],
  );

  // The review checklist covers everything still in "extracted" (a missing
  // state is treated as extracted, same as the grouping below).
  const extracted = useMemo(
    () =>
      insights.filter(
        (ins) => (typeof ins.state === "string" && ins.state ? ins.state : "extracted") === "extracted",
      ),
    [insights],
  );

  // Everything starts checked. Reset whenever the set of extracted ids changes
  // (initial load, after extract, after a batch action removes some).
  const extractedKey = useMemo(() => extracted.map((i) => i.id).join("|"), [extracted]);
  useEffect(() => {
    setSelected(new Set(extractedKey ? extractedKey.split("|") : []));
  }, [extractedKey]);

  // Group by state in pipeline order so the page reads Found -> Client told.
  const groups = useMemo(() => {
    const order = STATES as readonly string[];
    const byState = new Map<string, Insight[]>();
    for (const ins of insights) {
      const s = typeof ins.state === "string" && ins.state ? ins.state : "extracted";
      const bucket = byState.get(s);
      if (bucket) bucket.push(ins);
      else byState.set(s, [ins]);
    }
    return [...byState.entries()]
      .sort((a, b) => {
        const ia = order.indexOf(a[0]);
        const ib = order.indexOf(b[0]);
        return (ia === -1 ? order.length : ia) - (ib === -1 ? order.length : ib);
      })
      .map(([state, items]) => ({ state, items }));
  }, [insights]);

  const refreshInsights = useCallback(async () => {
    await loadDetail();
    if (clientId) {
      try {
        setListed(await api.listInsights({ client_id: clientId }));
      } catch {
        // Keep the stale list; the detail reload already updated the inline rows.
      }
    }
  }, [loadDetail, clientId]);

  const runBulk = useCallback(
    async (action: "triage" | "reject") => {
      const ids = [...selected];
      if (ids.length === 0 || bulkBusy) return;
      if (action === "triage" && !routeTrack) {
        toast.push("Pick a track first so we know where these go.", "warning");
        return;
      }
      setBulkBusy(action === "triage" ? "route" : "reject");
      try {
        const res = await api.bulkInsights(
          action === "triage"
            ? { ids, action, track: routeTrack, assignee_user_id: routeOwner || undefined }
            : { ids, action, reason: "Rejected during meeting review" },
        );
        const ok = typeof res?.ok === "number" ? res.ok : ids.length;
        const failed = typeof res?.failed === "number" ? res.failed : 0;
        const verb = action === "triage" ? "routed" : "rejected";
        toast.push(`${ok} ${verb}${failed ? `, ${failed} failed` : ""}.`, failed ? "warning" : "success");
        setConfirmReject(false);
        await refreshInsights();
      } catch (err) {
        toast.push(
          err instanceof ApiError ? err.message : "Could not update these insights. Try again.",
          "critical",
        );
      } finally {
        setBulkBusy(null);
      }
    },
    [selected, bulkBusy, routeTrack, routeOwner, toast, refreshInsights],
  );

  const doExtract = useCallback(async () => {
    if (!detail || extracting) return;
    setExtracting(true);
    try {
      const res = await api.extract(id);
      const created = typeof res?.created === "number" ? res.created : null;
      toast.push(
        created !== null
          ? `${created} ${created === 1 ? "insight" : "insights"} found in this meeting.`
          : "Insights found. Check them in Review.",
        "success",
      );
      await loadDetail();
      void loadBrief();
      if (clientId) {
        api
          .listInsights({ client_id: clientId })
          .then(setListed)
          .catch(() => undefined);
      }
    } catch (err) {
      toast.push(
        err instanceof ApiError ? err.message : "Could not read this meeting. Try again.",
        "critical",
      );
    } finally {
      setExtracting(false);
    }
  }, [detail, extracting, id, clientId, toast, loadDetail, loadBrief]);

  // ---------------------------------------------------------------- not found / error / loading

  if (notFound) {
    return (
      <div className="page-body">
        <EmptyState
          title="This meeting is gone."
          body="It may have been deleted. Everything else is still in Capture."
          action={
            <Btn
              variant="ghost"
              onClick={() => navigate("/capture")}
              tooltip="Open Capture to see all meetings."
            >
              Go to Capture
            </Btn>
          }
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-body">
        <ErrorAlert error={error} onRetry={() => void loadDetail()} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page-body">
        <Skeleton rows={6} />
      </div>
    );
  }

  // ---------------------------------------------------------------- the page

  const m = detail.meeting;
  const seq = meetingSeq(m);
  const title = m.title?.trim() || (seq !== null ? `Meeting ${seq}` : "Untitled meeting");
  const name = clientName ?? (typeof m.client_name === "string" ? m.client_name : "");
  const canExtract = detail.hasTranscript && m.status !== "extracted";

  // ---- brief-first review derivations
  const reviewActive = extracted.length > 0;
  const nSelected = selected.size;
  const allSelected = reviewActive && extracted.every((i) => selected.has(i.id));
  const toggleAll = () => {
    setSelected(allSelected ? new Set<string>() : new Set(extracted.map((i) => i.id)));
  };
  const toggleOne = (insightId: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(insightId)) next.delete(insightId);
      else next.add(insightId);
      return next;
    });
  };
  // Keep the reviewer pickable even when listUsers was not available (non-admins).
  const ownerOptions = user && !users.some((u) => u.id === user.id) ? [user, ...users] : users;

  // When review is active, the extracted bucket lives in the checklist above;
  // the groups below keep showing everything further along unchanged.
  const visibleGroups = reviewActive ? groups.filter((g) => g.state !== "extracted") : groups;

  const briefBlock = briefFailed ? (
    <p className="small muted" style={{ margin: 0 }}>
      The brief did not load. Reload the page to try again.
    </p>
  ) : brief === null ? (
    <Skeleton rows={3} />
  ) : brief.trim() === "" ? (
    <p className="small muted" style={{ margin: 0 }}>
      No brief yet. Extracting insights also writes a short brief of the meeting.
    </p>
  ) : (
    <Markdown text={brief} />
  );

  const extractBtn = (
    <Btn
      variant="primary"
      onClick={doExtract}
      disabled={extracting}
      tooltip="Read the conversation and pull out the insights. They land in Review for you to check."
      tooltipTitle="Extract insights"
    >
      {extracting ? "Reading the meeting" : "Extract insights"}
    </Btn>
  );

  return (
    <>
      <div className="head">
        <div className="row-between">
          <div>
            <h1>{title}</h1>
            <p>
              {name && <span>{name} · </span>}
              {m.meeting_date && <span>{formatDate(m.meeting_date)} · </span>}
              {m.status && <StatePill state={m.status} label={meetingStatusLabel(m.status)} />}
            </p>
          </div>
          <div className="row">
            {canExtract && extractBtn}
            {clientId && (
              <Btn
                variant="ghost"
                onClick={() => navigate(`/clients/${clientId}`)}
                tooltip="See this client's full picture: meetings, insights, and brief."
              >
                Open client
              </Btn>
            )}
          </div>
        </div>
      </div>

      <div className="page-body">
        <div className="meet-grid">
          {/* ---- main column: review pass (when anything is still Found), then groups, then brief */}
          <div>
            {reviewActive && (
              <>
                <div className="row-between mb-4">
                  <span className="lbl">Review this meeting</span>
                  <span className="tiny subtle mono">
                    {extracted.length} found, {nSelected} selected
                  </span>
                </div>
                <div className="card bf-card">
                  {/* The brief is the primary reading; the checklist sits under it. */}
                  <div className="dlbl mt-0">
                    Meeting brief
                  </div>
                  <div className="bf-brief">{briefBlock}</div>

                  <div className="bf-divider" />

                  <div className="row-between mb-2">
                    <div className="dlbl" style={{ margin: 0 }}>
                      Found in this meeting <span className="subtle">({extracted.length})</span>
                    </div>
                    <Btn
                      size="sm"
                      variant="ghost"
                      onClick={toggleAll}
                      tooltip="Tick or untick every insight in the list at once."
                    >
                      {allSelected ? "Select none" : "Select all"}
                    </Btn>
                  </div>
                  <div className="bf-list">
                    {extracted.map((ins) => (
                      <div className="bf-row" key={ins.id}>
                        <input
                          type="checkbox"
                          checked={selected.has(ins.id)}
                          onChange={() => toggleOne(ins.id)}
                          aria-label={`Include ${insightTitle(ins.title) || "Untitled insight"}`}
                          disabled={bulkBusy !== null}
                        />
                        <Link
                          to={`/insights/${ins.id}`}
                          className="bf-title"
                          aria-label={`Open insight: ${insightTitle(ins.title) || "Untitled"}`}
                        >
                          {insightTitle(ins.title) || "Untitled insight"}
                        </Link>
                        <ItemTypePill
                          type={typeof ins.item_type === "string" ? ins.item_type : undefined}
                        />
                      </div>
                    ))}
                  </div>

                  <div className="bf-route">
                    <label className="bf-field">
                      <span className="lbl">Track</span>
                      <select
                        className="ctrl"
                        value={routeTrack}
                        onChange={(e) => setRouteTrack(e.target.value)}
                        aria-label="Track for the selected insights"
                        disabled={bulkBusy !== null}
                      >
                        <option value="">Pick a track</option>
                        {TRACKS.map((t) => (
                          <option key={t} value={t}>
                            {trackLabel(t)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="bf-field">
                      <span className="lbl">Owner</span>
                      <select
                        className="ctrl"
                        value={routeOwner}
                        onChange={(e) => setRouteOwner(e.target.value)}
                        aria-label="Owner for the selected insights"
                        disabled={bulkBusy !== null}
                      >
                        <option value="">No owner yet</option>
                        {ownerOptions.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name || u.email}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="bf-actions">
                      <Btn
                        variant="primary"
                        onClick={() => void runBulk("triage")}
                        disabled={bulkBusy !== null || nSelected === 0 || !routeTrack}
                        tooltip="Mark every ticked insight as routed to this track and owner in one go. Wording stays editable afterwards."
                        tooltipTitle="Route the batch"
                      >
                        {bulkBusy === "route" ? "Routing" : `Route ${nSelected} selected`}
                      </Btn>
                      <Btn
                        variant="danger"
                        onClick={() => setConfirmReject(true)}
                        disabled={bulkBusy !== null || nSelected === 0}
                        tooltip="Reject every ticked insight. They stay on record but go no further."
                        tooltipTitle="Reject the batch"
                      >
                        Reject {nSelected} selected
                      </Btn>
                    </div>
                  </div>
                  <p className="helper mt-8">
                    Routing needs a track. Rejected insights stay on record but go no further, and
                    the client never hears about them.
                  </p>
                  <p className="helper">Need to reword one? Open it individually after routing.</p>
                </div>
              </>
            )}

            {(insights.length === 0 || visibleGroups.length > 0) && (
              <div className="row-between mb-4">
                <span className="lbl">
                  {reviewActive ? "Further along from this meeting" : "Insights from this meeting"}
                </span>
                {insights.length > 0 && (
                  <span className="tiny subtle mono">
                    {insights.length} {insights.length === 1 ? "insight" : "insights"}
                  </span>
                )}
              </div>
            )}

            {insights.length === 0 ? (
              <div className="card">
                <EmptyState
                  title="No insights yet."
                  body={
                    detail.hasTranscript
                      ? "The transcript is in. Extract insights to pull out what the client asked for."
                      : "This meeting has no transcript yet, so there is nothing to read. Add one from Capture first."
                  }
                  action={detail.hasTranscript ? extractBtn : undefined}
                />
              </div>
            ) : (
              visibleGroups.map((g) => (
                <div key={g.state}>
                  <div className="dlbl">
                    {stateLabel(g.state)}{" "}
                    <span className="subtle">({g.items.length})</span>
                  </div>
                  <div className="card p-0">
                    {g.items.map((ins) => (
                      <Link
                        key={ins.id}
                        to={`/insights/${ins.id}`}
                        className="lcard"
                        aria-label={`Open insight: ${insightTitle(ins.title) || "Untitled"}`}
                      >
                        <div className="t">{insightTitle(ins.title) || "Untitled insight"}</div>
                        <div className="meta">
                          <ItemTypePill
                            type={typeof ins.item_type === "string" ? ins.item_type : undefined}
                          />
                          <StatePill state={typeof ins.state === "string" ? ins.state : undefined} />
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))
            )}

            {/* When review is active the brief already sits at the top of the review card. */}
            {!reviewActive && (
              <>
                <div className="dlbl">Meeting brief</div>
                {brief !== null && brief.trim() !== "" && !briefFailed ? (
                  <div className="card">{briefBlock}</div>
                ) : (
                  briefBlock
                )}
              </>
            )}
          </div>

          {/* ---- side column: the facts */}
          <aside className="meet-side meet-facts">
            <div>
              <span className="lbl">Client</span>
              <div className="val">{name || "Unknown"}</div>
            </div>
            <div>
              <span className="lbl">Date</span>
              <div className="val">{m.meeting_date ? formatDate(m.meeting_date) : "No date"}</div>
            </div>
            <div>
              <span className="lbl">Type</span>
              <div className="val">
                {m.meeting_type ? titleCase(String(m.meeting_type)) : "Not set"}
              </div>
            </div>
            <div>
              <span className="lbl">Source</span>
              <div className="val">{m.source ? titleCase(String(m.source)) : "Manual"}</div>
            </div>
            <div>
              <span className="lbl">Consent</span>
              <div className="val">{m.consent_confirmed ? "Confirmed" : "Not confirmed"}</div>
            </div>
            <div>
              <Tooltip
                title="Transcript"
                content={
                  detail.hasTranscript
                    ? "The conversation text is attached, so insights can be extracted."
                    : "No conversation text yet. Add it from this meeting's row in Capture."
                }
              >
                <span className="lbl">Transcript</span>
              </Tooltip>
              <div className={`val ${detail.hasTranscript ? "tx-ok" : "tx-no"}`}>
                {detail.hasTranscript ? "Attached" : "Missing"}
              </div>
            </div>
            <div>
              <span className="lbl">Insights</span>
              {insights.length === 0 ? (
                <div className="val muted">None yet</div>
              ) : (
                <div className="val state-counts">
                  {groups.map((g) => (
                    <span key={g.state}>
                      <span className="mono">{g.items.length}</span> {stateLabel(g.state)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      <ConfirmModal
        open={confirmReject}
        title={`Reject ${nSelected} ${nSelected === 1 ? "insight" : "insights"}?`}
        body="Rejected insights stay on record but go no further. The client never hears about them."
        confirmLabel={`Reject ${nSelected}`}
        busy={bulkBusy === "reject"}
        onConfirm={() => void runBulk("reject")}
        onClose={() => setConfirmReject(false)}
      />

      <style>{meetingCss}</style>
    </>
  );
}

// ============================================================ page-scoped styles (tokens only)

const meetingCss = `
.bf-card { margin-bottom: 18px; }
.bf-brief { max-height: 320px; overflow: auto; }
.bf-divider { border-top: 1px solid var(--line); margin: 14px 0 10px; }
.bf-list { margin-bottom: 4px; }
.bf-row { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.bf-row:last-child { border-bottom: 0; }
.bf-row input[type="checkbox"] { width: 15px; height: 15px; margin: 0; accent-color: var(--accent); flex: 0 0 auto; }
.bf-title { flex: 1; min-width: 0; font-size: 13px; color: var(--ink); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bf-title:hover { text-decoration: underline; }
.bf-route { display: flex; align-items: flex-end; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
.bf-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 170px; }
.bf-field .lbl { display: block; }
.bf-actions { display: flex; gap: 8px; }
.meet-facts { display: flex; flex-direction: column; gap: 14px; }
.meet-facts .lbl { display: block; margin-bottom: 3px; }
.meet-facts .val { font-size: 13px; color: var(--ink); }
.meet-facts .tx-ok { color: var(--success); }
.meet-facts .tx-no { color: var(--warn); }
.meet-facts .state-counts { display: flex; flex-direction: column; gap: 4px; }
`;
