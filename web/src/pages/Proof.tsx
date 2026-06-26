import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type MatchProposal, type Release , insightHandle } from "../api";
import { formatDate, insightTitle, stateLabel } from "../format";
import {
  Alert,
  Btn,
  ConfirmModal,
  EmptyState,
  ErrorAlert,
  Field,
  SectionHead,
  Skeleton,
  Tooltip,
  useToast,
} from "../components/ui";

// Job: confirm what engineering shipped against client insights.
// Data: api.listMatches('proposed'), api.confirmMatch(id) / api.rejectMatch(id, reason),
//       api.listReleases().

type Tab = "matches" | "releases";

/** Plain-words meaning of the AI's confidence number on a match. */
function confidenceMeaning(n: number): { label: string; tip: string } {
  if (n >= 100) {
    return {
      label: "Confirmed",
      tip: "A person checked this and confirmed it shipped. Only a human confirm reaches 100.",
    };
  }
  if (n >= 80) {
    return {
      label: "Strong proof",
      tip: "The AI is fairly sure this release delivered the insight. Worth a quick look before you confirm.",
    };
  }
  if (n >= 50) {
    return {
      label: "Possible proof",
      tip: "The AI sees a likely link but is not sure. Read the release note before deciding.",
    };
  }
  return {
    label: "Weak proof",
    tip: "The AI is unsure these line up. Read carefully and reject if it does not fit.",
  };
}

function confidenceClass(n: number): string {
  if (n >= 100) return "st green";
  if (n >= 80) return "st white";
  return "st muted";
}

/** Normalize evidence quotes which may arrive as a string or an array. */
function quotesOf(m: MatchProposal): string[] {
  const q = m.evidence_quotes;
  if (Array.isArray(q)) return q.filter((x) => typeof x === "string" && x.trim().length > 0);
  if (typeof q === "string" && q.trim().length > 0) return [q.trim()];
  return [];
}

export function Proof() {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("matches");

  const [matches, setMatches] = useState<MatchProposal[] | null>(null);
  const [matchesError, setMatchesError] = useState<unknown>(null);

  const [releases, setReleases] = useState<Release[] | null>(null);
  const [releasesError, setReleasesError] = useState<unknown>(null);
  const [tokenConfigured, setTokenConfigured] = useState(true);
  const [releasesLoaded, setReleasesLoaded] = useState(false);

  // per-card busy + a confirmed flash so the row reads as resolved before refetch
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<MatchProposal | null>(null);

  const loadMatches = useCallback(async () => {
    setMatchesError(null);
    try {
      const rows = await api.listMatches("proposed");
      setMatches(rows);
    } catch (e) {
      setMatchesError(e);
      setMatches([]);
    }
  }, []);

  const loadReleases = useCallback(async () => {
    setReleasesError(null);
    try {
      const env = await api.releasesStatus();
      setReleases(env.releases ?? []);
      setTokenConfigured(env.github_token_configured !== false);
    } catch (e) {
      setReleasesError(e);
      setReleases([]);
    } finally {
      setReleasesLoaded(true);
    }
  }, []);

  useEffect(() => {
    void loadMatches();
  }, [loadMatches]);

  // lazy-load releases only when the tab is first opened
  useEffect(() => {
    if (tab === "releases" && !releasesLoaded) void loadReleases();
  }, [tab, releasesLoaded, loadReleases]);

  async function confirm(m: MatchProposal) {
    setBusyId(m.id);
    try {
      await api.confirmMatch(m.id);
      toast.push("Marked shipped.", "success");
      setMatches((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev));
      // a confirmed match becomes a release-backed proof; refresh releases if already loaded
      if (releasesLoaded) void loadReleases();
    } catch (e) {
      toast.push(e instanceof ApiError ? e.message : "Could not confirm. Try again.", "critical");
    } finally {
      setBusyId(null);
    }
  }

  async function doReject() {
    if (!rejectFor) return;
    const m = rejectFor;
    setBusyId(m.id);
    try {
      await api.rejectMatch(m.id);
      toast.push("Proof rejected.", "info");
      setMatches((prev) => (prev ? prev.filter((x) => x.id !== m.id) : prev));
      setRejectFor(null);
    } catch (e) {
      toast.push(e instanceof ApiError ? e.message : "Could not reject. Try again.", "critical");
    } finally {
      setBusyId(null);
    }
  }

  const matchCount = matches?.length ?? 0;

  return (
    <>
      <SectionHead
        title="Confirm shipped"
        job="When a release looks like it delivered an insight, confirm it or reject it."
        actions={
          tab === "matches" ? (
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => void loadMatches()}
              tooltip="Re-check for new proof the AI has proposed since you opened this page."
            >
              Refresh
            </Btn>
          ) : (
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => void loadReleases()}
              tooltip="Re-load the list of releases pulled from GitHub."
            >
              Refresh
            </Btn>
          )
        }
      />
      <div className="page-body">
        <div className="seg mb-18" role="tablist" aria-label="Confirm shipped views">
          <Tooltip content="Proposed proof waiting for your yes or no.">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "matches"}
              className={`seg-btn${tab === "matches" ? " on" : ""}`}
              onClick={() => setTab("matches")}
            >
              Waiting for you{matchCount > 0 ? ` (${matchCount})` : ""}
            </button>
          </Tooltip>
          <Tooltip content="Every release we pulled from GitHub or you added by hand, newest first.">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "releases"}
              className={`seg-btn${tab === "releases" ? " on" : ""}`}
              onClick={() => setTab("releases")}
            >
              Releases
            </button>
          </Tooltip>
        </div>

        {tab === "matches" ? (
          <MatchesTab
            matches={matches}
            error={matchesError}
            onRetry={() => void loadMatches()}
            busyId={busyId}
            onConfirm={confirm}
            onRejectOpen={(m) => setRejectFor(m)}
          />
        ) : (
          <ReleasesTab
            releases={releases}
            error={releasesError}
            tokenConfigured={tokenConfigured}
            onRetry={() => void loadReleases()}
            onManualSaved={() => {
              void loadReleases();
              void loadMatches();
            }}
          />
        )}
      </div>

      <ConfirmModal
        open={!!rejectFor}
        title="Reject this proof"
        body="This release does not deliver the insight. The insight stays open and the AI can propose a different release later."
        confirmLabel="Reject proof"
        busy={busyId === rejectFor?.id}
        onConfirm={() => void doReject()}
        onClose={() => setRejectFor(null)}
      />
    </>
  );
}

function MatchesTab({
  matches,
  error,
  onRetry,
  busyId,
  onConfirm,
  onRejectOpen,
}: {
  matches: MatchProposal[] | null;
  error: unknown;
  onRetry: () => void;
  busyId: string | null;
  onConfirm: (m: MatchProposal) => void;
  onRejectOpen: (m: MatchProposal) => void;
}) {
  if (error && (!matches || matches.length === 0)) {
    return <ErrorAlert error={error} onRetry={onRetry} />;
  }
  if (matches === null) {
    return <Skeleton rows={6} />;
  }
  if (matches.length === 0) {
    return (
      <EmptyState
        title="Nothing to confirm right now"
        body="When a new release lines up with a client insight, it will appear here."
      />
    );
  }
  return (
    <div className="stack">
      {matches.map((m) => (
        <MatchCard
          key={m.id}
          m={m}
          busy={busyId === m.id}
          onConfirm={() => onConfirm(m)}
          onRejectOpen={() => onRejectOpen(m)}
        />
      ))}
    </div>
  );
}

function MatchCard({
  m,
  busy,
  onConfirm,
  onRejectOpen,
}: {
  m: MatchProposal;
  busy: boolean;
  onConfirm: () => void;
  onRejectOpen: () => void;
}) {
  const conf = typeof m.confidence === "number" ? m.confidence : 0;
  const meaning = confidenceMeaning(conf);
  const quotes = quotesOf(m);
  const handle = m.insight_handle || (m.insight_id ? insightHandle(String(m.insight_id)) : "");
  const releaseTag = m.release_tag || "release";

  return (
    <div className="card corner">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <span className="lbl" style={{ margin: 0 }}>
          Proposed proof
        </span>
        <Tooltip title={`Confidence ${conf}`} content={meaning.tip}>
          <span className={confidenceClass(conf)}>
            {meaning.label} · {conf}
          </span>
        </Tooltip>
      </div>

      <div className="grid-2" style={{ marginTop: 14, alignItems: "start" }}>
        {/* The insight */}
        <div>
          <div className="lbl mt-0">
            What the client asked for
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>{insightTitle(m.insight_title) || "Untitled insight"}</div>
          {handle && (
            <div className="mono subtle" style={{ fontSize: 11, marginTop: 6 }}>
              {handle}
            </div>
          )}
        </div>

        {/* The release */}
        <div>
          <div className="lbl mt-0">
            What engineering shipped
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <span className="pill feat">{releaseTag}</span>
            {m.release_published_at && (
              <span className="subtle" style={{ fontSize: 11 }}>
                {formatDate(m.release_published_at)}
              </span>
            )}
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.45 }}>{m.entry_title || m.entry_text || "Release entry"}</div>
        </div>
      </div>

      {m.rationale && (
        <div className="aibox">
          <b>Why the AI matched these:</b> {m.rationale}
        </div>
      )}

      {quotes.length > 0 && (
        <>
          <div className="lbl">Proof from the release note</div>
          <div className="stack-sm">
            {quotes.map((q, i) => (
              <div key={i} className="quote">
                {q}
              </div>
            ))}
          </div>
        </>
      )}

      <div className="actions" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          onClick={onConfirm}
          disabled={busy}
          tooltip="Marks the insight shipped and records that this release delivered it. The client can then be told."
          tooltipTitle="Confirm shipped"
        >
          {busy ? "Working" : "Confirm shipped"}
        </Btn>
        <Btn
          variant="danger"
          onClick={onRejectOpen}
          disabled={busy}
          tooltip="This release does not cover the insight. The insight stays open for future proof."
          tooltipTitle="Reject"
        >
          Reject
        </Btn>
        <span className="muted small" style={{ marginLeft: "var(--sp-1)" }}>
          Confirming moves the insight to {stateLabel("shipped")} right away. Rejecting keeps it open.
        </span>
      </div>
    </div>
  );
}

function ReleasesTab({
  releases,
  error,
  tokenConfigured,
  onRetry,
  onManualSaved,
}: {
  releases: Release[] | null;
  error: unknown;
  tokenConfigured: boolean;
  onRetry: () => void;
  onManualSaved: () => void;
}) {
  const rows = useMemo(() => releases ?? [], [releases]);

  if (releases === null && !error) {
    return <Skeleton rows={6} />;
  }

  if (error && rows.length === 0) {
    return (
      <div className="stack">
        <ErrorAlert error={error} onRetry={onRetry} />
        <ManualChangelogForm onSaved={onManualSaved} />
      </div>
    );
  }

  if (rows.length === 0) {
    if (!tokenConfigured) {
      // No GitHub token: the manual form IS the primary action here.
      return (
        <div className="manual-empty-wide">
          <style>{`.manual-empty-wide .empty { max-width: 720px; }`}</style>
          <EmptyState
            title="GitHub is not connected yet"
            body="The release repo is private, so pulling needs a read-only GitHub token. Add GITHUB_READ_TOKEN to the server's .env and restart; releases then pull automatically every hour. Until then, add changelogs by hand below."
            action={
              <div style={{ textAlign: "left" }}>
                <ManualChangelogForm onSaved={onManualSaved} />
              </div>
            }
          />
        </div>
      );
    }
    return (
      <div className="stack">
        <EmptyState
          title="No releases yet"
          body="Releases pull automatically every hour. An admin can also pull right now from the Settings page."
        />
        <ManualChangelogForm onSaved={onManualSaved} />
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card p-0">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Release</th>
                <th>Published</th>
                <th className="num">
                  <Tooltip title="Entries" content="How many separate changelog lines this release contained.">
                    <span>Entries</span>
                  </Tooltip>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const tag = r.tag || r.tag_name || r.name || "release";
                const count = typeof r.entry_count === "number" ? r.entry_count : null;
                return (
                  <tr key={r.id ?? tag ?? i}>
                    <td>
                      <span className="pill feat">{tag}</span>
                      {r.name && r.name !== tag && (
                        <span className="muted" style={{ marginLeft: 8 }}>
                          {r.name}
                        </span>
                      )}
                    </td>
                    <td className="muted">{r.published_at ? formatDate(r.published_at) : "Unknown"}</td>
                    <td className="num">{count ?? "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <ManualChangelogForm onSaved={onManualSaved} />
    </div>
  );
}

// ================================================================ Manual changelog intake

/**
 * Paste-or-upload changelog intake. Works without a GitHub token; that is its
 * whole point. Saves the changelog, then asks the server to match its entries
 * against open insights.
 */
function ManualChangelogForm({ onSaved }: { onSaved: () => void }) {
  const toast = useToast();
  const [tag, setTag] = useState("");
  const [name, setName] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    // allow choosing the same file again after an edit
    e.target.value = "";
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      setBodyMd(typeof reader.result === "string" ? reader.result : "");
      toast.push(`Loaded ${f.name} into the notes box.`, "info");
    };
    reader.onerror = () => {
      toast.push("Could not read that file. Paste the notes into the box instead.", "warning");
    };
    reader.readAsText(f);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const tagTrimmed = tag.trim();
    if (!tagTrimmed) {
      setFormError("Enter the version or tag, for example v1.21.0.");
      return;
    }
    if (!bodyMd.trim()) {
      setFormError("Paste the changelog notes or choose a .md or .txt file.");
      return;
    }
    setSaving(true);
    try {
      const r = await api.addManualRelease({
        tag_name: tagTrimmed,
        name: name.trim() || undefined,
        body_md: bodyMd,
      });
      const entries = typeof r?.entry_count === "number" ? r.entry_count : 0;
      const proposed = typeof r?.matches_proposed === "number" ? r.matches_proposed : 0;
      toast.push(`${entries} changelog entries saved. ${proposed} proposed matches to confirm.`, "success");
      if (r?.match_error) {
        toast.push("Matching failed, but the changelog saved. No proposed matches were created this time.", "info");
      }
      setTag("");
      setName("");
      setBodyMd("");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // duplicate tag: show the server's message
        setFormError(err.message);
      } else {
        setFormError(err instanceof ApiError ? err.message : "Could not save the changelog. Try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void save(e)}>
      <div>
        <h3 className="dlbl" style={{ margin: 0 }}>
          Add a changelog manually
        </h3>
        <p className="muted small" style={{ margin: "6px 0 0", lineHeight: 1.5 }}>
          Paste release notes or load a .md or .txt file. We split the notes into entries and propose
          matches against open insights for you to confirm above.
        </p>
      </div>

      {formError && (
        <Alert severity="warning" title="Could not save" onDismiss={() => setFormError(null)}>
          {formError}
        </Alert>
      )}

      <div className="grid-2">
        <Field label="Version or tag" htmlFor="mc-tag" hint="Required. The release tag, e.g. v1.21.0.">
          <input
            id="mc-tag"
            className="ctrl mono"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="v1.21.0"
          />
        </Field>
        <Field label="Name" htmlFor="mc-name" hint="Optional. A human name for the release.">
          <input
            id="mc-name"
            className="ctrl"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="June platform release"
          />
        </Field>
      </div>

      <Field
        label="Release notes"
        htmlFor="mc-notes"
        hint="Paste the changelog here, or load a file below and it fills this box."
      >
        <textarea
          id="mc-notes"
          className="ctrl mono"
          rows={8}
          value={bodyMd}
          onChange={(e) => setBodyMd(e.target.value)}
          placeholder={"## Added\n- Faster exports for large accounts\n\n## Fixed\n- Login loop on expired sessions"}
        />
      </Field>

      <Field label="Or load a file" htmlFor="mc-file" hint="Accepts .md or .txt. The file is read in your browser and fills the notes box; nothing uploads until you save.">
        <input id="mc-file" className="ctrl" type="file" accept=".md,.txt,text/markdown,text/plain" onChange={onFile} />
      </Field>

      <div className="form-actions" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <Btn
          variant="primary"
          type="submit"
          disabled={saving}
          tooltip="Saves the changelog, splits it into entries, and proposes matches against open insights in the Waiting for you tab."
          tooltipTitle="Save and match"
        >
          {saving ? "Saving" : "Save and match against open insights"}
        </Btn>
        <span className="muted small">
          Use this when GitHub is not connected. Pasting the same version twice is rejected.
        </span>
      </div>
    </form>
  );
}
