import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Client } from "../api";
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

// Job: what each client asked for and what we owe them.
// Data: api.listClients() -> table; api.createClient() -> new row.

/** Reads the open-asks count under either field name the backend might send. */
function openAsks(c: Client): number {
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

  const load = useCallback(async () => {
    setError(null);
    try {
      const rows = await api.listClients();
      // Sort by open asks first (most owed work up top), then name.
      rows.sort((a, b) => openAsks(b) - openAsks(a) || (a.name ?? "").localeCompare(b.name ?? ""));
      setClients(rows);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function onCreated(created: Client) {
    setShowNew(false);
    toast.push(`Added ${created.name || "client"}.`, "success");
    void load();
    if (created.id) navigate(`/clients/${created.id}`);
  }

  return (
    <>
      <SectionHead
        title="Clients"
        job="What each client asked for and what we owe them."
        actions={
          <Btn
            variant="primary"
            onClick={() => setShowNew(true)}
            tooltipTitle="New client"
            tooltip="Add a client so you can log meetings and track their asks. Opens a short form."
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
            body="Add your first client, then log a meeting to start pulling out their asks."
            action={
              <Btn
                variant="primary"
                onClick={() => setShowNew(true)}
                tooltipTitle="New client"
                tooltip="Add a client to start tracking their meetings and asks."
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
                  <th>Domain</th>
                  <th className="num">
                    Meetings{" "}
                    <Help
                      title="Meetings"
                      content="How many meetings we have logged with this client."
                    />
                  </th>
                  <th className="num">
                    Open asks{" "}
                    <Help
                      title="Open asks"
                      content="Things this client asked for that are not yet shipped and confirmed back to them."
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {clients.map((c) => {
                  const asks = openAsks(c);
                  return (
                    <tr
                      key={c.id}
                      className="clickable"
                      onClick={() => navigate(`/clients/${c.id}`)}
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
                      </td>
                      <td className="muted">{c.domain || "Not set"}</td>
                      <td className="num">{meetings(c)}</td>
                      <td className="num">
                        {asks > 0 ? (
                          <Tooltip
                            title="Open asks"
                            content="Asks we still owe this client. Open the client to see them."
                          >
                            <span style={{ color: "var(--accent-soft)" }}>{asks}</span>
                          </Tooltip>
                        ) : (
                          <span className="subtle">0</span>
                        )}
                      </td>
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
