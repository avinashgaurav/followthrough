import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError, asArray } from "../api";
import type { Client } from "../api";
import { useListSelection } from "../components/shortcuts";
import {
  Btn,
  EmptyState,
  ErrorAlert,
  Field,
  Help,
  Modal,
  SectionHead,
  Skeleton,
  Tooltip,
  useToast,
} from "../components/ui";

// Job: answer "what do we owe each client?" at a glance.
// Data: api.listClients() -> table; api.metricsOverview() -> loop-closed pct
// (admin only; the column hides itself when that call is not allowed);
// api.createClient() -> new row.

/** Reads the open-insights count under either field name the backend might send. */
function openInsightCount(c: Client): number {
  const v = c.open_insight_count ?? (c as Record<string, unknown>).open_insights_count;
  return typeof v === "number" ? v : 0;
}

/** Reads the meetings count under either field name. */
function meetings(c: Client): number {
  const v = c.meeting_count ?? (c as Record<string, unknown>).meetings_count;
  return typeof v === "number" ? v : 0;
}

export function Clients() {
  const navigate = useNavigate();
  const toast = useToast();

  const [clients, setClients] = useState<Client[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showNew, setShowNew] = useState(false);

  // client_id -> loop-closed percent. null = metrics not available for this
  // user (the column simply does not render). We never fake a number.
  const [loopPct, setLoopPct] = useState<Map<string, number> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await api.listClients();
      // Sort by open insights first (most owed work up top), then name.
      rows.sort(
        (a, b) => openInsightCount(b) - openInsightCount(a) || (a.name ?? "").localeCompare(b.name ?? ""),
      );
      setClients(rows);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const overview = await api.metricsOverview();
        const rows = asArray<{ client_id?: string; closed_loop_pct?: number | null }>(
          (overview as Record<string, unknown>).per_client_closed_loop,
        );
        const map = new Map<string, number>();
        for (const r of rows) {
          if (r.client_id && typeof r.closed_loop_pct === "number") map.set(r.client_id, r.closed_loop_pct);
        }
        if (alive) setLoopPct(map);
      } catch {
        // Metrics are admin-only. Not an error here: just leave the column out.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  function onCreated(created: Client) {
    setShowNew(false);
    toast.push(`Added ${created.name || "client"}.`, "success");
    void load();
    if (created.id) navigate(`/clients/${created.id}`);
  }

  // Keyboard inbox, same idiom as Review and Library: j/k highlight a client
  // row, Enter opens it. The highlighted row scrolls into view as it moves.
  const rowList = clients ?? [];
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);
  const { index: selIndex, setIndex: setSelIndex } = useListSelection(
    rowList.length,
    (i) => {
      const c = rowList[i];
      if (c?.id) navigate(`/clients/${c.id}`);
    },
    rowList.length > 0,
  );
  useEffect(() => {
    rowRefs.current[selIndex]?.scrollIntoView({ block: "nearest" });
  }, [selIndex]);

  const showLoop = loopPct !== null;

  return (
    <>
      <SectionHead
        title="Clients"
        job="What we still owe each client. Biggest debts at the top."
        actions={
          <Btn
            variant="primary"
            onClick={() => setShowNew(true)}
            tooltipTitle="New client"
            tooltip="Add a client so you can log meetings and track their insights. Opens a short form."
          >
            New client
          </Btn>
        }
      />

      <div className="page-body">
        {error ? (
          <ErrorAlert error={error} onRetry={load} />
        ) : clients === null ? (
          <Skeleton rows={6} />
        ) : clients.length === 0 ? (
          <EmptyState
            title="No clients yet."
            body="Add your first client, then log a meeting to start pulling out their insights."
            action={
              <Btn
                variant="primary"
                onClick={() => setShowNew(true)}
                tooltipTitle="New client"
                tooltip="Add a client to start tracking their meetings and insights."
              >
                New client
              </Btn>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th className="num">
                    Open insights{" "}
                    <Help
                      title="Open insights"
                      content="Insights from this client that are not yet shipped and confirmed back to them. This is what we still owe them."
                    />
                  </th>
                  {showLoop && (
                    <th className="num">
                      Loop closed{" "}
                      <Help
                        title="Loop closed"
                        content="Of the insights we locked for this client, the share where the client was told it shipped. 100% means nothing locked is still waiting on a confirmation."
                      />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {clients.map((c, idx) => {
                  const open = openInsightCount(c);
                  const meet = meetings(c);
                  const pct = c.id ? loopPct?.get(c.id) : undefined;
                  return (
                    <tr
                      key={c.id}
                      ref={(el) => {
                        rowRefs.current[idx] = el;
                      }}
                      className={`clickable${idx === selIndex ? " row-sel" : ""}`}
                      aria-selected={idx === selIndex}
                      onClick={() => {
                        setSelIndex(idx);
                        navigate(`/clients/${c.id}`);
                      }}
                      tabIndex={0}
                      role="link"
                      aria-label={`Open ${c.name || "client"}`}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          navigate(`/clients/${c.id}`);
                        }
                      }}
                    >
                      <td>
                        <span style={{ fontWeight: 500 }}>{c.name || "Untitled client"}</span>
                        <div className="muted small">
                          {c.domain ? `${c.domain} · ` : ""}
                          {meet} {meet === 1 ? "meeting" : "meetings"}
                        </div>
                      </td>
                      <td className="num">
                        {open > 0 ? (
                          <Tooltip
                            title="Open insights"
                            content={`We still owe this client ${open} ${open === 1 ? "insight" : "insights"}. Open the client to see what and what to do next.`}
                          >
                            <span
                              className="hot"
                              style={{ color: "var(--accent-soft)", fontSize: 17, fontWeight: 600 }}
                            >
                              {open}
                            </span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Nothing owed" content="Every insight from this client has been closed out.">
                            <span className="subtle">0</span>
                          </Tooltip>
                        )}
                      </td>
                      {showLoop && (
                        <td className="num">
                          {typeof pct === "number" ? (
                            <Tooltip
                              title="Loop closed"
                              content="Of the insights we locked for this client, the share where the client was told it shipped."
                            >
                              <span>{Math.round(pct)}%</span>
                            </Tooltip>
                          ) : (
                            <Tooltip
                              title="No number yet"
                              content="Nothing has been locked for this client yet, so there is no loop to measure."
                            >
                              <span className="subtle">-</span>
                            </Tooltip>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewClientModal open={showNew} onClose={() => setShowNew(false)} onCreated={onCreated} />
    </>
  );
}

// ---------------------------------------------------------------- New client modal

function NewClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (c: Client) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset the form whenever the modal opens.
  useEffect(() => {
    if (open) {
      setName("");
      setDomain("");
      setContactName("");
      setContactEmail("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Give the client a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: { name: string; domain?: string; contacts?: Array<{ name?: string; email?: string }> } = {
        name: trimmedName,
      };
      if (domain.trim()) body.domain = domain.trim();
      if (contactName.trim() || contactEmail.trim()) {
        body.contacts = [{ name: contactName.trim() || undefined, email: contactEmail.trim() || undefined }];
      }
      // api.createClient is typed for {name, domain} but the contract accepts contacts too.
      const res = await api.createClient(body as { name: string; domain?: string });
      const client: Client =
        (res?.client as Client) ??
        ({ id: typeof res?.id === "string" ? res.id : "", name: trimmedName, domain: domain.trim() || null } as Client);
      onCreated(client);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Could not add the client. Try again.";
      setError(msg);
      toast.push(msg, "critical");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="New client"
      onClose={onClose}
      footer={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={submit}
            disabled={busy}
            tooltip="Saves the client. We will take you straight to their page."
          >
            {busy ? "Adding" : "Add client"}
          </Btn>
        </>
      }
    >
      <div className="stack">
        <Field
          label="Client name"
          htmlFor="nc-name"
          hint="The company or account name, as you would say it out loud."
          error={error && !name.trim() ? error : null}
        >
          <input
            id="nc-name"
            className={`ctrl${error && !name.trim() ? " error" : ""}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </Field>

        <Field
          label="Domain"
          htmlFor="nc-domain"
          hint="Optional. Their website, used to match calendar invites to this client."
        >
          <input
            id="nc-domain"
            className="ctrl"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.com"
          />
        </Field>

        <div>
          <p className="lbl" style={{ margin: "4px 0 8px" }}>
            First contact (optional)
          </p>
          <div className="grid-2">
            <Field label="Contact name" htmlFor="nc-cname">
              <input
                id="nc-cname"
                className="ctrl"
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Jane Doe"
              />
            </Field>
            <Field label="Contact email" htmlFor="nc-cemail">
              <input
                id="nc-cemail"
                className="ctrl"
                type="email"
                value={contactEmail}
                onChange={(e) => setContactEmail(e.target.value)}
                placeholder="jane@acme.com"
              />
            </Field>
          </div>
        </div>

        {error && name.trim() ? <p className="helper error">{error}</p> : null}
      </div>
    </Modal>
  );
}
