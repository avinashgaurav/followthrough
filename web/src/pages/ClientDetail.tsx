import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, asArray } from "../api";
import type { Client, Contact, Insight, Meeting } from "../api";
import {
  Btn,
  EmptyState,
  ErrorAlert,
  Help,
  Markdown,
  Pill,
  SectionHead,
  Skeleton,
  Spine,
  SpineItem,
  StatePill,
  Tooltip,
  useToast,
} from "../components/ui";
import { formatDate, titleCase, trackLabel } from "../format";

// Job: one client, full picture. Data: api.getClient(id), api.getBrief(id),
// api.exportCsv(id) + download.

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

export function ClientDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [data, setData] = useState<ClientDetailData | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [brief, setBrief] = useState<string | null>(null);
  const [briefError, setBriefError] = useState<unknown>(null);
  const [briefLoading, setBriefLoading] = useState(false);

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
    void loadBrief();
  }, [id, loadDetail, loadBrief]);

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
        // Backend did not return an id; best effort is to tell the user it is queued.
        toast.push("Export started. Check Settings for the file.", "info");
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
            toast.push("CSV ready.", "success");
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
          toast.push("CSV ready.", "success");
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

  return (
    <>
      <SectionHead
        title={client.name || "Client"}
        job="What this client asked for and what we still owe them."
        actions={
          <>
            <Btn
              variant="ghost"
              onClick={() => navigate("/clients")}
              tooltip="Back to the full client list."
            >
              All clients
            </Btn>
            <Btn
              onClick={onExport}
              disabled={exporting}
              tooltipTitle="Export for CRM"
              tooltip="Builds a CSV of this client's asks and what shipped, then downloads it so you can paste it into your CRM."
            >
              {exporting ? "Building CSV" : "Export for CRM"}
            </Btn>
          </>
        }
      />

      <div className="page-body stack">
        {/* ---- Header card: domain + contacts */}
        <div className="card">
          <div className="row-between">
            <div className="row" style={{ gap: 12 }}>
              {client.domain ? (
                <span className="muted small">{client.domain}</span>
              ) : (
                <span className="subtle small">No domain set</span>
              )}
              {Boolean((client as Record<string, unknown>).is_internal) && (
                <Pill label="Internal" kind="ins" />
              )}
            </div>
          </div>

          <p className="lbl" style={{ margin: "16px 0 8px" }}>
            Contacts
          </p>
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

        {/* ---- Open asks rollup */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              Open asks
              <Help
                title="Open asks"
                content="Everything this client asked for that we have not yet shipped and confirmed back to them."
              />
            </h3>
            <span className="lbl">{openInsights.length} open</span>
          </div>
          {openInsights.length === 0 ? (
            <div className="card">
              <p className="muted small" style={{ margin: 0 }}>
                Nothing outstanding. Every ask from this client has been closed out.
              </p>
            </div>
          ) : (
            <div className="card" style={{ padding: 0 }}>
              {openInsights.map((ins) => (
                <Link
                  key={ins.id}
                  to={`/insights/${ins.id}`}
                  className="lcard"
                  aria-label={`Open ask: ${ins.title || "Untitled"}`}
                >
                  <div className="t">{ins.title || "Untitled ask"}</div>
                  <div className="meta">
                    <StatePill state={ins.state} />
                    <Tooltip
                      title="Where it goes"
                      content="Which team owns moving this ask forward."
                    >
                      <span>{trackLabel(ins.track)}</span>
                    </Tooltip>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* ---- Meeting timeline */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              Meeting timeline
              <Help
                title="Meeting timeline"
                content="Every meeting with this client, oldest first. The number badge is the meeting order."
              />
            </h3>
            <span className="lbl">{orderedMeetings.length} meetings</span>
          </div>
          {orderedMeetings.length === 0 ? (
            <div className="card">
              <p className="muted small" style={{ margin: "0 0 12px" }}>
                No meetings logged yet. Capture one to start pulling out this client's asks.
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
            <div className="card">
              <Spine>
                {orderedMeetings.map((m, i) => {
                  const seq = meetingSeq(m);
                  // Oldest first; the most recent meeting (last) sits at the live playhead.
                  const isLatest = i === orderedMeetings.length - 1;
                  return (
                    <SpineItem
                      key={m.id}
                      timecode={formatDate(m.meeting_date)}
                      state={isLatest ? "live" : "done"}
                    >
                      {/* Plain (non-link) meeting row: Capture has no working meeting deep-link (audit A1). */}
                      <div className="t" style={{ display: "flex", alignItems: "center", gap: 9 }}>
                        {seq !== null && (
                          <Tooltip
                            title="Meeting order"
                            content={`This is meeting number ${seq} with this client.`}
                          >
                            <span className="num subtle" style={{ fontSize: 11 }}>
                              #{seq}
                            </span>
                          </Tooltip>
                        )}
                        <span>{m.title || "Untitled meeting"}</span>
                      </div>
                      <div className="meta">
                        {m.meeting_type ? <span>{titleCase(m.meeting_type)}</span> : null}
                        {m.status ? (
                          <>
                            {m.meeting_type ? <span aria-hidden="true">·</span> : null}
                            <StatePill state={m.status} />
                          </>
                        ) : null}
                      </div>
                    </SpineItem>
                  );
                })}
              </Spine>
            </div>
          )}
        </section>

        {/* ---- Pre-call brief */}
        <section>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <h3 style={{ fontSize: 15, display: "flex", alignItems: "center", gap: 7 }}>
              Pre-call brief
              <Help
                title="Pre-call brief"
                content="What to read before your next call: open asks, what shipped since last time, and follow-ups owed."
              />
            </h3>
            <Btn
              size="sm"
              variant="ghost"
              onClick={loadBrief}
              disabled={briefLoading}
              tooltip="Rebuild the brief from the latest meetings and asks."
            >
              {briefLoading ? "Refreshing" : "Refresh"}
            </Btn>
          </div>
          <div className="card corner">
            {briefError ? (
              <ErrorAlert error={briefError} onRetry={loadBrief} />
            ) : briefLoading && brief === null ? (
              <Skeleton rows={5} />
            ) : brief && brief.trim() ? (
              <Markdown text={brief} />
            ) : (
              <EmptyState
                title="No brief yet."
                body="Once this client has a meeting or an open ask, a brief will write itself here."
                action={
                  <Btn
                    size="sm"
                    onClick={loadBrief}
                    disabled={briefLoading}
                    tooltip="Try building the brief now."
                  >
                    Build brief
                  </Btn>
                }
              />
            )}
          </div>
        </section>
      </div>
    </>
  );
}
