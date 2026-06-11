import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type SttStatus, type User } from "../api";
import { formatDate } from "../format";
import {
  Alert,
  Btn,
  ConfirmModal,
  EmptyState,
  ErrorAlert,
  Field,
  Help,
  Markdown,
  Modal,
  SectionHead,
  Skeleton,
  Tooltip,
  useToast,
} from "../components/ui";

// Admin. Job: users, calendar feed, releases, digest, search.
// Data: listUsers/createUser/rotateCode/revokeUser, calendarStatus/setCalendar/deleteCalendar,
//       pollReleases, digestPreview, rebuildSearch, sttStatus, watchfolderStatus.

function readCode(r: { loginCode?: string; login_code?: string } | undefined | null): string {
  if (!r) return "";
  return r.loginCode ?? r.login_code ?? "";
}

export function Settings() {
  return (
    <>
      <SectionHead title="Settings" job="Users, calendar feed, releases, digest, and search." />
      <div className="page-body stack" style={{ display: "flex", flexDirection: "column", gap: 28, maxWidth: 860 }}>
        <UsersSection />
        <CalendarSection />
        <ReleasesSection />
        <DigestSection />
        <SearchSection />
        <SystemSection />
      </div>
    </>
  );
}

function Panel({
  title,
  desc,
  actions,
  children,
}: {
  title: string;
  desc: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="row-between" style={{ marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>{title}</h2>
          <p className="muted small" style={{ margin: "3px 0 0", maxWidth: 560, lineHeight: 1.5 }}>
            {desc}
          </p>
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

// ================================================================ Users

function UsersSection() {
  const toast = useToast();
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // the freshly issued / rotated code, shown ONCE
  const [revealed, setRevealed] = useState<{ code: string; who: string; rotated: boolean } | null>(null);

  const [revokeUser, setRevokeUser] = useState<User | null>(null);
  const [rotateUser, setRotateUser] = useState<User | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setUsers(await api.listUsers());
    } catch (e) {
      setError(e);
      setUsers([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    const mail = email.trim().toLowerCase();
    if (!name.trim()) {
      setAddError("Enter a name.");
      return;
    }
    if (!mail.endsWith("@xyz.com")) {
      setAddError("Use a @xyz.com email. Only @xyz.com accounts can sign in.");
      return;
    }
    setAdding(true);
    try {
      const r = await api.createUser({ email: mail, name: name.trim(), role });
      const code = readCode(r);
      setAddOpen(false);
      setName("");
      setEmail("");
      setRole("member");
      if (code) setRevealed({ code, who: name.trim() || mail, rotated: false });
      else toast.push("User added.", "success");
      void load();
    } catch (err) {
      setAddError(err instanceof ApiError ? err.message : "Could not add the user. Try again.");
    } finally {
      setAdding(false);
    }
  }

  async function doRotate() {
    if (!rotateUser) return;
    const u = rotateUser;
    setRowBusy(u.id);
    try {
      const r = await api.rotateCode(u.id);
      const code = readCode(r);
      setRotateUser(null);
      if (code) setRevealed({ code, who: u.name || u.email, rotated: true });
      else toast.push("Code rotated.", "success");
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "Could not rotate the code.", "critical");
    } finally {
      setRowBusy(null);
    }
  }

  async function doRevoke() {
    if (!revokeUser) return;
    const u = revokeUser;
    setRowBusy(u.id);
    try {
      await api.revokeUser(u.id);
      toast.push("Access revoked.", "info");
      setRevokeUser(null);
      void load();
    } catch (err) {
      toast.push(err instanceof ApiError ? err.message : "Could not revoke access.", "critical");
    } finally {
      setRowBusy(null);
    }
  }

  function copyCode(code: string) {
    void navigator.clipboard
      ?.writeText(code)
      .then(() => toast.push("Login code copied.", "success"))
      .catch(() => toast.push("Copy failed. Select and copy it by hand.", "warning"));
  }

  return (
    <Panel
      title="Users"
      desc="People who can sign in. Each gets a one-time login code you share with them."
      actions={
        <Btn
          variant="primary"
          size="sm"
          onClick={() => {
            setAddError(null);
            setAddOpen(true);
          }}
          tooltip="Create a teammate and get a login code to hand them. The code shows only once."
        >
          Add user
        </Btn>
      }
    >
      {revealed && (
        <div style={{ marginBottom: 14 }}>
          <Alert
            severity="success"
            title={revealed.rotated ? "New login code" : "User added"}
            onDismiss={() => setRevealed(null)}
          >
            <p style={{ margin: "0 0 8px" }}>
              Share this login code with {revealed.who} now. It will not be shown again. If they lose it,
              rotate the code to issue a new one.
            </p>
            <div className="row" style={{ gap: 8 }}>
              <code
                className="mono"
                style={{
                  background: "var(--p2)",
                  border: "1px solid var(--line)",
                  borderRadius: "var(--r)",
                  padding: "6px 10px",
                  fontSize: 14,
                  letterSpacing: "0.08em",
                }}
              >
                {revealed.code}
              </code>
              <Btn size="sm" onClick={() => copyCode(revealed.code)} tooltip="Copy the code to your clipboard.">
                Copy
              </Btn>
            </div>
          </Alert>
        </div>
      )}

      {error && (!users || users.length === 0) ? (
        <ErrorAlert error={error} onRetry={() => void load()} />
      ) : users === null ? (
        <Skeleton rows={4} />
      ) : users.length === 0 ? (
        <EmptyState title="No users yet" body="Add the first teammate to let them sign in." />
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const revoked = !!u.revoked_at;
                  return (
                    <tr key={u.id}>
                      <td>{u.name || "-"}</td>
                      <td className="mono" style={{ fontSize: 12 }}>
                        {u.email}
                      </td>
                      <td>
                        <span className="pill">{u.role}</span>
                      </td>
                      <td>
                        {revoked ? (
                          <Tooltip title="Revoked" content="This person can no longer sign in.">
                            <span className="st red">Revoked</span>
                          </Tooltip>
                        ) : (
                          <Tooltip title="Active" content="This person can sign in with their login code.">
                            <span className="st green">Active</span>
                          </Tooltip>
                        )}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <Btn
                            size="sm"
                            variant="ghost"
                            disabled={revoked || rowBusy === u.id}
                            onClick={() => setRotateUser(u)}
                            tooltip="Issue a fresh login code and invalidate the old one. Use if a code leaked or was lost."
                          >
                            Rotate code
                          </Btn>
                          <Btn
                            size="sm"
                            variant="danger"
                            disabled={revoked || rowBusy === u.id}
                            onClick={() => setRevokeUser(u)}
                            tooltip="Block this person from signing in. Their record stays on file."
                          >
                            Revoke
                          </Btn>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={addOpen}
        title="Add a user"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Btn variant="ghost" onClick={() => setAddOpen(false)} disabled={adding}>
              Cancel
            </Btn>
            <Btn variant="primary" type="submit" form="add-user-form" disabled={adding}>
              {adding ? "Adding" : "Add user"}
            </Btn>
          </>
        }
      >
        <form id="add-user-form" onSubmit={submitAdd} className="stack">
          {addError && (
            <Alert severity="warning" title="Check the form" onDismiss={() => setAddError(null)}>
              {addError}
            </Alert>
          )}
          <Field label="Name" htmlFor="nu-name">
            <input
              id="nu-name"
              className="ctrl"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Avinash Gaurav"
            />
          </Field>
          <Field label="Work email" htmlFor="nu-email" hint="Must be a @xyz.com address.">
            <input
              id="nu-email"
              className="ctrl mono"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@xyz.com"
            />
          </Field>
          <Field
            label="Role"
            htmlFor="nu-role"
            help="Admins can reach Numbers and Settings. Members cannot."
          >
            <select id="nu-role" className="ctrl" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </form>
      </Modal>

      <ConfirmModal
        open={!!rotateUser}
        danger={false}
        title="Rotate login code"
        body={
          <span>
            This issues a fresh login code for {rotateUser?.name || rotateUser?.email} and stops the old
            one working. You will see the new code once.
          </span>
        }
        confirmLabel="Rotate code"
        busy={rowBusy === rotateUser?.id}
        onConfirm={() => void doRotate()}
        onClose={() => setRotateUser(null)}
      />

      <ConfirmModal
        open={!!revokeUser}
        title="Revoke access"
        body={
          <span>
            {revokeUser?.name || revokeUser?.email} will no longer be able to sign in. Their record stays
            on file.
          </span>
        }
        confirmLabel="Revoke access"
        busy={rowBusy === revokeUser?.id}
        onConfirm={() => void doRevoke()}
        onClose={() => setRevokeUser(null)}
      />
    </Panel>
  );
}

// ================================================================ Calendar feed

function CalendarSection() {
  const toast = useToast();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api.calendarStatus();
      setConfigured(!!r?.configured);
    } catch (e) {
      setError(e);
      setConfigured(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    const u = url.trim();
    if (!u) {
      toast.push("Paste the iCal feed URL first.", "warning");
      return;
    }
    setSaving(true);
    try {
      await api.setCalendar(u);
      toast.push("Calendar feed connected.", "success");
      setUrl("");
      void load();
    } catch (e) {
      toast.push(e instanceof ApiError ? e.message : "Could not connect the feed.", "critical");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api.deleteCalendar();
      toast.push("Calendar feed removed.", "info");
      setRemoveOpen(false);
      void load();
    } catch (e) {
      toast.push(e instanceof ApiError ? e.message : "Could not remove the feed.", "critical");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Panel
      title="Calendar feed"
      desc="Connect a read-only iCal feed so upcoming meetings show up on the Capture page, ready to log."
    >
      {error ? (
        <ErrorAlert error={error} onRetry={() => void load()} />
      ) : configured === null ? (
        <Skeleton rows={2} />
      ) : configured ? (
        <div className="card">
          <div className="row-between">
            <div className="row" style={{ gap: 8 }}>
              <span className="st green">Connected</span>
              <span className="muted small">Upcoming meetings appear on Capture.</span>
            </div>
            <Btn
              variant="danger"
              size="sm"
              onClick={() => setRemoveOpen(true)}
              tooltip="Disconnect the feed. Already-logged meetings stay; new ones stop appearing on Capture."
            >
              Remove
            </Btn>
          </div>
        </div>
      ) : (
        <div className="card stack">
          <Field
            label="iCal feed URL"
            htmlFor="cal-url"
            help={
              <span>
                In Google Calendar, open Settings, pick the calendar, then copy the "Secret address in
                iCal format". It is a long https URL ending in .ics. Treat it like a password.
              </span>
            }
            hint="Paste the secret iCal URL. We only read it; we never change your calendar."
          >
            <input
              id="cal-url"
              className="ctrl mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://calendar.google.com/.../basic.ics"
            />
          </Field>
          <div className="form-actions">
            <Btn
              variant="primary"
              onClick={() => void save()}
              disabled={saving}
              tooltip="Save the feed. Upcoming meetings will start appearing on the Capture page."
            >
              {saving ? "Connecting" : "Connect feed"}
            </Btn>
          </div>
        </div>
      )}

      <ConfirmModal
        open={removeOpen}
        title="Remove calendar feed"
        body="New meetings will stop appearing on Capture. Meetings you already logged are unaffected."
        confirmLabel="Remove feed"
        busy={removing}
        onConfirm={() => void remove()}
        onClose={() => setRemoveOpen(false)}
      />
    </Panel>
  );
}

// ================================================================ Releases

function ReleasesSection() {
  const toast = useToast();
  const [polling, setPolling] = useState(false);

  async function poll() {
    setPolling(true);
    try {
      const r = await api.pollReleases();
      const o = (r ?? {}) as Record<string, unknown>;
      const added =
        (typeof o.added === "number" && o.added) ||
        (typeof o.new === "number" && o.new) ||
        (typeof o.created === "number" && o.created) ||
        (typeof o.releases === "number" && o.releases) ||
        0;
      const matches =
        (typeof o.matches === "number" && o.matches) ||
        (typeof o.proposed === "number" && o.proposed) ||
        0;
      toast.push(
        `Pulled releases. ${added} new release${added === 1 ? "" : "s"}` +
          (matches ? `, ${matches} new match${matches === 1 ? "" : "es"} to confirm.` : "."),
        "success",
      );
    } catch (e) {
      toast.push(e instanceof ApiError ? e.message : "Could not pull releases.", "critical");
    } finally {
      setPolling(false);
    }
  }

  return (
    <Panel
      title="Releases"
      desc="Pull the latest releases from GitHub. New ones get matched against client asks on the Proof page."
    >
      <div className="card">
        <div className="row-between">
          <span className="muted small">Releases are usually pulled automatically. Use this to pull now.</span>
          <Btn
            variant="primary"
            size="sm"
            onClick={() => void poll()}
            disabled={polling}
            tooltip="Fetch new releases from GitHub right now and run the matcher against open asks."
          >
            {polling ? "Pulling" : "Poll now"}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

// ================================================================ Digest

function DigestSection() {
  const [md, setMd] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setMd(await api.digestPreview());
    } catch (e) {
      setError(e);
      setMd("");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Panel
      title="Weekly digest"
      desc="A summary of the week's progress. This is sent automatically every Monday. Below is a live preview."
      actions={
        <Btn
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          tooltip="Re-build the preview from the latest data."
        >
          Refresh preview
        </Btn>
      }
    >
      <div className="card corner" style={{ maxHeight: 380, overflow: "auto" }}>
        {error ? (
          <ErrorAlert error={error} onRetry={() => void load()} />
        ) : md === null ? (
          <Skeleton rows={6} />
        ) : md.trim() === "" ? (
          <p className="muted small" style={{ margin: 0 }}>
            Nothing to summarize yet. Once asks move through the pipeline, the Monday digest will fill in.
          </p>
        ) : (
          <Markdown text={md} />
        )}
      </div>
    </Panel>
  );
}

// ================================================================ Search

function SearchSection() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function rebuild() {
    setBusy(true);
    try {
      await api.rebuildSearch();
      toast.push("Search index rebuilt.", "success");
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        toast.push("Rebuild is not available on this server. Search stays up to date on its own.", "warning");
      } else {
        toast.push(e instanceof ApiError ? e.message : "Could not rebuild search.", "critical");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel
      title="Search"
      desc="Search across insights and transcripts stays current on its own. Rebuild only if results look stale."
    >
      <div className="card">
        <div className="row-between">
          <span className="muted small">Rebuilds the index so search matches recent edits exactly.</span>
          <Btn
            size="sm"
            onClick={() => void rebuild()}
            disabled={busy}
            tooltip="Re-index every insight and transcript. Safe to run anytime; takes a moment."
          >
            {busy ? "Rebuilding" : "Rebuild search index"}
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

// ================================================================ System status

function SystemSection() {
  const [stt, setStt] = useState<SttStatus | null>(null);
  const [sttError, setSttError] = useState<unknown>(null);
  const [watch, setWatch] = useState<Record<string, unknown> | null>(null);
  const [watchError, setWatchError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setSttError(null);
    setWatchError(null);
    try {
      setStt(await api.sttStatus());
    } catch (e) {
      setSttError(e);
      setStt({});
    }
    try {
      setWatch(await api.watchfolderStatus());
    } catch (e) {
      setWatchError(e);
      setWatch({});
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sttOk = !!(stt && (stt.available || stt.enabled || (stt as Record<string, unknown>).ok));
  const sttMissing = stt ? (stt as Record<string, unknown>).missing : undefined;
  const missingList = Array.isArray(sttMissing) ? (sttMissing as unknown[]).map(String) : [];

  const wo = watch ?? {};
  const watchEnabled = !!(wo.enabled ?? wo.configured ?? wo.active ?? wo.ok);
  const watchPath = typeof wo.path === "string" ? wo.path : typeof wo.folder === "string" ? wo.folder : "";
  const pending =
    typeof wo.pending === "number"
      ? wo.pending
      : typeof wo.queued === "number"
        ? wo.queued
        : typeof wo.backlog === "number"
          ? wo.backlog
          : null;
  const lastSeen =
    typeof wo.last_seen === "string"
      ? wo.last_seen
      : typeof wo.last_ingest === "string"
        ? wo.last_ingest
        : typeof wo.last_run === "string"
          ? wo.last_run
          : "";

  return (
    <Panel
      title="System status"
      desc="Quick health of the helpers that run in the background."
      actions={
        <Btn size="sm" variant="ghost" onClick={() => void load()} tooltip="Re-check both helpers.">
          Refresh
        </Btn>
      }
    >
      <div className="grid-2">
        <div className="card">
          <div className="row-between" style={{ marginBottom: 6 }}>
            <span className="lbl" style={{ margin: 0 }}>
              Transcription
            </span>
            <Help
              title="Transcription"
              content="Turns uploaded meeting audio into text automatically. Needs its keys set on the server."
            />
          </div>
          {sttError ? (
            <ErrorAlert error={sttError} onRetry={() => void load()} />
          ) : stt === null ? (
            <Skeleton rows={2} />
          ) : sttOk ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="st green">Available</span>
              <span className="muted small">Audio uploads can be transcribed.</span>
            </div>
          ) : (
            <div className="stack-sm">
              <div className="row" style={{ gap: 8 }}>
                <span className="st muted">Off</span>
                <span className="muted small">Audio cannot be transcribed yet. Paste transcripts by hand.</span>
              </div>
              {missingList.length > 0 && (
                <p className="subtle tiny mono" style={{ margin: 0 }}>
                  Missing: {missingList.join(", ")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="card">
          <div className="row-between" style={{ marginBottom: 6 }}>
            <span className="lbl" style={{ margin: 0 }}>
              Watch folder
            </span>
            <Help
              title="Watch folder"
              content="A folder the system watches. Drop a transcript file in and it gets pulled in automatically."
            />
          </div>
          {watchError ? (
            <ErrorAlert error={watchError} onRetry={() => void load()} />
          ) : watch === null ? (
            <Skeleton rows={2} />
          ) : watchEnabled ? (
            <div className="stack-sm">
              <div className="row" style={{ gap: 8 }}>
                <span className="st green">Watching</span>
                {pending !== null && (
                  <span className="muted small">
                    {pending} file{pending === 1 ? "" : "s"} waiting to process
                  </span>
                )}
              </div>
              {watchPath && (
                <p className="subtle tiny mono" style={{ margin: 0 }}>
                  {watchPath}
                </p>
              )}
              {lastSeen && <p className="subtle tiny" style={{ margin: 0 }}>Last activity {formatDate(lastSeen)}</p>}
            </div>
          ) : (
            <div className="row" style={{ gap: 8 }}>
              <span className="st muted">Off</span>
              <span className="muted small">Not watching any folder. Upload transcripts on Capture instead.</span>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
