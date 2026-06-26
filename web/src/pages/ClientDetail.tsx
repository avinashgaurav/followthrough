import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, asArray } from "../api";
import type { Client, Contact, Insight, Meeting } from "../api";
import {
  Btn,
  ConfirmModal,
  ErrorAlert,
  Help,
  Markdown,
  Pill,
  SectionHead,
  Skeleton,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import { formatDate, stateLabel, titleCase, trackLabel, insightTitle, meetingStatusLabel } from "../format";
import { useAuth } from "../auth";

// Job: one client, ordered by what matters: prep for the next call first,
// then what we still owe them, then the meeting history, then the admin bits.
// Data: api.getClient(id), api.getBrief(id), api.metricsOverview() (best
// effort, admin only), api.exportCsv(id) + download.

interface ClientDetailData {
  client: Client;
  contacts: Contact[];
  meetings: Meeting[];
  openInsights: Insight[];
}

/** getClient returns a loose object; pull the pieces out defensively. */
function shapeDetail(raw: Record<string, unknown>): ClientDetailData {
  const client = (raw.client as Client) ?? (raw as Client) ?? ({ id: "", name: "" } as Client);
  return {
    client,
    contacts: asArray<Contact>(raw.contacts),
    meetings: asArray<Meeting>(raw.meetings),
    openInsights: asArray<Insight>(raw.open_insights ?? raw.openInsights),
  };
}

/** Meetings come back with seq or seq_no; show whichever exists. */
function meetingSeq(m: Meeting): number | null {
  const v = m.seq ?? m.seq_no;
  return typeof v === "number" ? v : null;
}

// The one thing to do next for an insight in each state. Shown once per group.
const NEXT_ACTION: Record<string, string> = {
  extracted: "Review it",
  triaged: "Lock wording",
  finalized: "Raise ticket",
  ticketed: "Waiting on engineering",
  shipped: "Tell them",
  client_notified: "Close it out",
};

// Pipeline order for the "What we owe them" groups.
const STATE_ORDER = ["extracted", "triaged", "finalized", "ticketed", "shipped", "client_notified"];

/** Group open insights by state, in pipeline order; unknown states go last. */
function groupByState(insights: Insight[]): Array<{ state: string; rows: Insight[] }> {
  const byState = new Map<string, Insight[]>();
  for (const ins of insights) {
    const s = typeof ins.state === "string" && ins.state ? ins.state : "extracted";
    const bucket = byState.get(s);
    if (bucket) bucket.push(ins);
    else byState.set(s, [ins]);
  }
  const groups: Array<{ state: string; rows: Insight[] }> = [];
  for (const s of STATE_ORDER) {
    const rows = byState.get(s);
    if (rows) {
      groups.push({ state: s, rows });
      byState.delete(s);
    }
  }
  for (const [s, rows] of byState) groups.push({ state: s, rows });
  return groups;
}

export function ClientDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [data, setData] = useState<ClientDetailData | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Share link (admin only). The relative URL lives in local state; the client
  // payload may or may not carry share_token, so we prefill when it does.
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const shareInputRef = useRef<HTMLInputElement | null>(null);

  const [brief, setBrief] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<unknown>(null);
  const [briefLoading, setBriefLoading] = useState(false);

  // Loop-closed percent for the header sentence. Admin-only metrics; when the
  // call is not allowed we just leave that part of the sentence out.
  const [loopPct, setLoopPct] = useState<number | null>(null);

  const [exporting, setExporting] = useState(false);

  const loadDetail = useCallback(async () => {
    setError(null);
    try {
      const raw = await api.getClient(id);
      setData(shapeDetail(raw));
    } catch (e) {
      setError(e);
    }
  }, [id]);

  const loadBrief = useCallback(async () => {
    setBriefLoading(true);
    setBriefError(null);
    try {
      const md = await api.getBrief(id);
      setBrief(md);
    } catch (e) {
      setBriefError(e);
    } finally {
      setBriefLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    void loadDetail();
  }, [id, loadDetail]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    void (async () => {
      try {
        const overview = await api.metricsOverview();
        const rows = asArray<{ client_id?: string; closed_loop_pct?: number | null }>(
          (overview as Record<string, unknown>).per_client_closed_loop,
        );
        const mine = rows.find((r) => r.client_id === id);
        if (alive && mine && typeof mine.closed_loop_pct === "number") {
          setLoopPct(mine.closed_loop_pct);
        }
      } catch {
        // Metrics are admin-only. Leave the percent out of the sentence.
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // ----- Export for CRM: kick off the CSV, wait for it to be ready, then download.

  const pollRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (pollRef.current) window.clearTimeout(pollRef.current);
  }, []);

  function triggerDownload(exportId: string) {
    const url = api.exportDownloadUrl(exportId);
    const a = document.createElement("a");
    a.href = url;
    a.rel = "noopener";
    // Hint a download; the server sets the real filename via Content-Disposition.
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function onExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await api.exportCsv(id);
      const exportId =
        (typeof res?.id === "string" && res.id) ||
        (typeof res?.export_id === "string" && res.export_id) ||
        "";
      if (!exportId) {
        // Backend did not return an id. Look the export up in the exports list
        // (newest for this client) so we can still hand over the file.
        try {
          const exports = await api.listExports();
          const newest = exports
            .filter((x) => x.id && (!x.client_id || x.client_id === id))
            .sort(
              (a, b) =>
                (b.created_at ? Date.parse(b.created_at) : 0) -
                (a.created_at ? Date.parse(a.created_at) : 0),
            )[0];
          if (newest?.id) {
            triggerDownload(newest.id);
            toast.push("Export ready. Downloading the CSV now.", "success");
            setExporting(false);
            return;
          }
        } catch {
          // Listing failed; fall through to the honest message below.
        }
        toast.push("Export started, but no download link came back. Try again in a moment.", "info");
        setExporting(false);
        return;
      }

      // Poll the exports list a few times for this id to become ready, then download.
      let tries = 0;
      const check = async () => {
        tries += 1;
        try {
          const exports = await api.listExports();
          const me = exports.find((x) => x.id === exportId);
          const status = (me?.status ?? "").toLowerCase();
          const ready = !me || status === "" || status === "ready" || status === "done" || status === "complete";
          if (ready) {
            triggerDownload(exportId);
            toast.push("CSV ready. Downloading now.", "success");
            setExporting(false);
            return;
          }
          if (status === "failed" || status === "error") {
            toast.push("That export did not finish. Try again.", "critical");
            setExporting(false);
            return;
          }
        } catch {
          // Listing failed; fall back to a direct download attempt below.
        }
        if (tries >= 6) {
          triggerDownload(exportId);
          toast.push("CSV ready. Downloading now.", "success");
          setExporting(false);
          return;
        }
        pollRef.current = window.setTimeout(() => void check(), 700);
      };
      await check();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not build the CSV. Try again.";
      toast.push(msg, "critical");
      setExporting(false);
    }
  }

  // ----- Share link: create, copy, revoke. URL shape from the backend is /share/<token>.

  // If the client record already carries a share token, show the existing link.
  // Runs only when fresh detail data arrives, so a local revoke is not undone.
  useEffect(() => {
    const token = data?.client ? (data.client as Record<string, unknown>).share_token : null;
    if (typeof token === "string" && token) {
      setShareUrl((u) => u ?? `/share/${token}`);
    }
  }, [data]);

  const fullShareUrl = shareUrl
    ? shareUrl.startsWith("http")
      ? shareUrl
      : `${window.location.origin}${shareUrl}`
    : "";

  async function onCreateShareLink() {
    if (shareBusy) return;
    setShareBusy(true);
    try {
      const res = await api.createShareLink(id);
      if (typeof res?.url === "string" && res.url) {
        setShareUrl(res.url);
        toast.push("Share link created. Copy it and send it to the client.", "success");
      } else {
        toast.push("The link was created but no URL came back. Reload the page and try again.", "warning");
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not create the share link. Try again.";
      toast.push(msg, "critical");
    } finally {
      setShareBusy(false);
    }
  }

  async function onCopyShareLink() {
    if (!fullShareUrl) return;
    let copied = false;
    try {
      await navigator.clipboard.writeText(fullShareUrl);
      copied = true;
    } catch {
      // Clipboard API can be unavailable (http, older browsers). Fall back to
      // selecting the read-only input and using the legacy copy command.
      const el = shareInputRef.current;
      if (el) {
        el.focus();
        el.select();
        try {
          copied = document.execCommand("copy");
        } catch {
          copied = false;
        }
      }
    }
    if (copied) {
      toast.push("Link copied.", "success");
    } else {
      toast.push("Could not copy automatically. Select the link text and copy it yourself.", "warning");
    }
  }

  async function onRevokeShareLink() {
    if (revoking) return;
    setRevoking(true);
    try {
      await api.revokeShareLink(id);
      setShareUrl(null);
      setRevokeOpen(false);
      toast.push("Share link revoked. The old link no longer works.", "success");
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not revoke the link. Try again.";
      toast.push(msg, "critical");
    } finally {
      setRevoking(false);
    }
  }

  // ----- render

  if (error) {
    return (
      <>
        <SectionHead title="Client" job="What this client asked for and what we still owe them." />
        <div className="page-body">
          <ErrorAlert error={error} onRetry={loadDetail} />
          <div style={{ marginTop: 14 }}>
            <Btn variant="ghost" onClick={() => navigate("/clients")} tooltip="Back to the full client list.">
              Back to clients
            </Btn>
          </div>
        </div>
      </>
    );
  }

  if (data === null) {
    return (
      <>
        <SectionHead title="Client" job="What this client asked for and what we still owe them." />
        <div className="page-body">
          <Skeleton rows={8} />
        </div>
      </>
    );
  }

  const { client, contacts, meetings, openInsights } = data;

  // Meetings chronological (oldest first), seq badges read #1, #2, #3 in order.
  const orderedMeetings = [...meetings].sort((a, b) => {
    const sa = meetingSeq(a);
    const sb = meetingSeq(b);
    if (sa !== null && sb !== null) return sa - sb;
    const da = a.meeting_date ? Date.parse(a.meeting_date) : 0;
    const db = b.meeting_date ? Date.parse(b.meeting_date) : 0;
    return da - db;
  });

  const groups = groupByState(openInsights);

  // One-line status sentence from real numbers. Only parts that exist render.
  const statusParts = [
    `${openInsights.length} open ${openInsights.length === 1 ? "insight" : "insights"}`,
    `${orderedMeetings.length} ${orderedMeetings.length === 1 ? "meeting" : "meetings"}`,
  ];
  if (loopPct !== null) statusParts.push(`loop closed ${Math.round(loopPct)}%`);

  return (
    <>
      <SectionHead
        title={client.name || "Client"}
        job={statusParts.join(" · ")}
        actions={
          <Btn
            variant="ghost"
            onClick={() => navigate("/clients")}
            tooltip="Back to the full client list."
          >
            All clients
          </Btn>
        }
      />

      <div className="page-body stack">
        {/* ---- 1. Before your next call: the pre-call brief, front and center */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              Before your next call
              <Help
                title="Pre-call brief"
                content="A one-page brief built from this client's record: open insights, what shipped since last time, and follow-ups owed."
              />
            </h3>
            {brief && brief.trim() ? (
              <Btn
                size="sm"
                variant="ghost"
                onClick={loadBrief}
                disabled={briefLoading}
                tooltip="Rebuilds the brief from the latest meetings and insights."
              >
                {briefLoading ? "Rebuilding" : "Rebuild the brief"}
              </Btn>
            ) : null}
          </div>
          <div className="card corner">
            {briefError ? (
              <ErrorAlert error={briefError} onRetry={loadBrief} />
            ) : briefLoading ? (
              <Skeleton rows={5} />
            ) : brief && brief.trim() ? (
              <Markdown text={brief} />
            ) : (
              <>
                <p className="muted small" style={{ margin: "0 0 12px" }}>
                  One page with everything to know before you talk to {client.name || "this client"}: open
                  insights, what shipped since last time, and follow-ups owed.
                </p>
                <Btn
                  variant="primary"
                  onClick={loadBrief}
                  disabled={briefLoading}
                  tooltip="Builds the brief from this client's meetings and insights. Takes a moment."
                >
                  Build the pre-call brief
                </Btn>
              </>
            )}
          </div>
        </section>

        {/* ---- 2. What we owe them: open insights grouped by pipeline state */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              What we owe them
              <Help
                title="What we owe them"
                content="Everything this client asked for that we have not yet shipped and confirmed back to them, grouped by where it sits in the pipeline."
              />
            </h3>
            <span className="lbl">{openInsights.length} open</span>
          </div>
          {openInsights.length === 0 ? (
            <div className="card">
              <p className="muted small" style={{ margin: 0 }}>
                Nothing outstanding. Every insight from this client has been closed out.
              </p>
            </div>
          ) : (
            <div className="stack" style={{ gap: 14 }}>
              {groups.map(({ state, rows }) => (
                <div key={state}>
                  <div className="row-between" style={{ marginBottom: 6 }}>
                    <span className="lbl">
                      {stateLabel(state)} · {rows.length}
                    </span>
                    <Tooltip
                      title="Next step"
                      content={`What to do with ${rows.length === 1 ? "this insight" : "these insights"} to move ${rows.length === 1 ? "it" : "them"} forward.`}
                    >
                      <span className="lbl">Next: {NEXT_ACTION[state] ?? "Open it"}</span>
                    </Tooltip>
                  </div>
                  <div className="card" style={{ padding: 0 }}>
                    {rows.map((ins) => (
                      <Link
                        key={ins.id}
                        to={`/insights/${ins.id}`}
                        className="lcard"
                        aria-label={`Open insight: ${insightTitle(ins.title) || "Untitled"}`}
                      >
                        <div className="t">{insightTitle(ins.title) || "Untitled insight"}</div>
                        <div className="meta">
                          <StatePill state={ins.state} />
                          <Tooltip
                            title="Where it goes"
                            content="Which team owns moving this insight forward."
                          >
                            <span>{trackLabel(ins.track)}</span>
                          </Tooltip>
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ---- 2b. Share with the client: tokenized read-only page (admin only) */}
        {isAdmin && (
          <section>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
                Share with the client
                <Help
                  title="Client share page"
                  content="A read-only page built for this client: what they asked for and what already shipped. It shows nothing internal. Only people with the link can open it."
                />
              </h3>
            </div>
            <div className="card">
              <p className="muted small" style={{ margin: "0 0 12px" }}>
                A read-only page the client can open: everything they asked for and what already
                shipped. The link is unguessable and revocable.
              </p>
              {shareUrl ? (
                <>
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <input
                      ref={shareInputRef}
                      className="ctrl mono"
                      readOnly
                      value={fullShareUrl}
                      aria-label="Client share link"
                      onFocus={(e) => e.currentTarget.select()}
                      style={{ flex: "1 1 320px", fontSize: 12 }}
                    />
                    <Btn
                      size="sm"
                      onClick={() => void onCopyShareLink()}
                      tooltip="Puts the full link on your clipboard."
                    >
                      Copy link
                    </Btn>
                    <Btn
                      size="sm"
                      variant="danger"
                      className="ghost"
                      onClick={() => setRevokeOpen(true)}
                      tooltip="Turns the link off for everyone who has it."
                    >
                      Revoke
                    </Btn>
                  </div>
                  <p className="subtle small" style={{ margin: "10px 0 0" }}>
                    Revoking stops this link immediately for anyone who has it. You can create a
                    new link afterwards.
                  </p>
                </>
              ) : (
                <Btn
                  variant="primary"
                  onClick={() => void onCreateShareLink()}
                  disabled={shareBusy}
                  tooltip="Makes a private link for this client. Nothing is sent until you share it."
                >
                  {shareBusy ? "Creating link" : "Create share link"}
                </Btn>
              )}
            </div>
          </section>
        )}

        {/* ---- 3. Meetings: every conversation, oldest first, each opens the meeting page */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              Meetings
              <Help
                title="Meetings"
                content="Every meeting with this client, oldest first. The number badge is the meeting order. Click one to see its transcript and the insights it produced."
              />
            </h3>
            <span className="lbl">{orderedMeetings.length} meetings</span>
          </div>
          {orderedMeetings.length === 0 ? (
            <div className="card">
              <p className="muted small" style={{ margin: "0 0 12px" }}>
                No meetings logged yet. Capture one to start pulling out this client's insights.
              </p>
              <Btn
                size="sm"
                variant="primary"
                onClick={() => navigate("/capture")}
                tooltip="Log a meeting transcript or recording for this client."
              >
                Capture a meeting
              </Btn>
            </div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              {orderedMeetings.map((m) => {
                const seq = meetingSeq(m);
                return (
                  <Link
                    key={m.id}
                    to={`/meetings/${m.id}`}
                    className="lcard"
                    aria-label={`Open meeting ${m.title || ""}`}
                  >
                    <div className="t" style={{ display: "flex", alignItems: "center", gap: 9 }}>
                      {seq !== null && (
                        <Tooltip title="Meeting order" content={`This is meeting number ${seq} with this client.`}>
                          <span className="num subtle" style={{ fontSize: 11 }}>
                            #{seq}
                          </span>
                        </Tooltip>
                      )}
                      <span>{m.title || "Untitled meeting"}</span>
                    </div>
                    <div className="meta">
                      <span>{formatDate(m.meeting_date)}</span>
                      {m.meeting_type ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{titleCase(m.meeting_type)}</span>
                        </>
                      ) : null}
                      {m.status ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <StatePill state={m.status} label={meetingStatusLabel(m.status)} />
                        </>
                      ) : null}
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        {/* ---- 4. The admin bits: contacts and the CRM export, below the work */}
        <section>
          <p className="dlbl">Contacts</p>
          <div className="card">
            <div className="row" style={{ gap: 12, marginBottom: contacts.length === 0 ? 10 : 12 }}>
              {client.domain ? (
                <span className="muted small">{client.domain}</span>
              ) : (
                <span className="subtle small">No domain set</span>
              )}
              {Boolean((client as Record<string, unknown>).is_internal) && (
                <Pill label="Internal" kind="ins" />
              )}
            </div>
            {contacts.length === 0 ? (
              <p className="subtle small" style={{ margin: 0 }}>
                No contacts on file yet.
              </p>
            ) : (
              <div className="chips">
                {contacts.map((ct, i) => (
                  <Tooltip
                    key={ct.id ?? ct.email ?? i}
                    title={ct.name || "Contact"}
                    content={
                      <>
                        {ct.email ? <div>{ct.email}</div> : <div>No email on file</div>}
                        {(ct as Record<string, unknown>).title ? (
                          <div className="subtle">{String((ct as Record<string, unknown>).title)}</div>
                        ) : null}
                      </>
                    }
                  >
                    <span className="chip">
                      {ct.name || ct.email || "Contact"}
                      {ct.email && ct.name ? <span className="subtle"> · {ct.email}</span> : null}
                    </span>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        </section>

        <section>
          <p className="dlbl">Export</p>
          <div className="card">
            <p className="muted small" style={{ margin: "0 0 12px" }}>
              A CSV of this client's insights and what shipped, ready to paste into your CRM.
            </p>
            <Btn
              size="sm"
              onClick={onExport}
              disabled={exporting}
              tooltipTitle="Export for CRM"
              tooltip="Builds the CSV and downloads it when ready. Takes a few seconds."
            >
              {exporting ? "Building CSV" : "Export for CRM"}
            </Btn>
          </div>
        </section>
      </div>

      <ConfirmModal
        open={revokeOpen}
        title="Revoke the share link?"
        body="The old link stops working immediately."
        confirmLabel="Revoke link"
        busy={revoking}
        onConfirm={() => void onRevokeShareLink()}
        onClose={() => setRevokeOpen(false)}
      />
    </>
  );
}
