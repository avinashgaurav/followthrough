import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type MatchProposal, type Release } from "../api";
import { formatDate } from "../format";
import {
  Btn,
  ConfirmModal,
  EmptyState,
  ErrorAlert,
  PaperBand,
  SectionHead,
  Skeleton,
  Spine,
  SpineItem,
  TestimonyQuote,
  Tooltip,
  useToast,
} from "../components/ui";

// Job: confirm what engineering shipped against client asks.
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
      label: "Strong match",
      tip: "The AI is fairly sure this release delivered the ask. Worth a quick look before you confirm.",
    };
  }
  if (n >= 50) {
    return {
      label: "Possible match",
      tip: "The AI sees a likely link but is not sure. Read the release note before deciding.",
    };
  }
  return {
    label: "Weak match",
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
      toast.push("Marked shipped", "success");
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
      toast.push("Match rejected", "info");
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
        title="Proof"
        job="Confirm what engineering shipped against client asks."
        actions={
          tab === "matches" ? (
            <Btn
              size="sm"
              variant="ghost"
              onClick={() => void loadMatches()}
              tooltip="Re-check for new matches the AI has proposed since you opened this page."
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
        <p className="muted small" style={{ margin: "0 0 16px", maxWidth: 680, lineHeight: 1.6 }}>
          When a release looks like it delivered something a client asked for, the AI proposes a match
          here. Confirm it to mark the ask shipped, or reject it if the release does not actually cover
          what they wanted.
        </p>

        <div className="row" style={{ gap: 6, marginBottom: 18 }}>
          <Btn
            size="sm"
            variant={tab === "matches" ? "primary" : "default"}
            onClick={() => setTab("matches")}
            tooltip="Proposed matches waiting for your yes or no."
          >
            Matches to confirm{matchCount > 0 ? ` (${matchCount})` : ""}
          </Btn>
          <Btn
            size="sm"
            variant={tab === "releases" ? "primary" : "default"}
            onClick={() => setTab("releases")}
            tooltip="Every release we pulled from GitHub, newest first."
          >
            Releases
          </Btn>
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
          />
        )}
      </div>

      <ConfirmModal
        open={!!rejectFor}
        title="Reject this match"
        body="This release does not deliver the ask. The ask stays open and the AI can propose a different release later."
        confirmLabel="Reject match"
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
        title="No matches waiting"
        body="Nothing to confirm right now. When a new release lines up with a client ask, it will appear here."
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
  const handle = m.insight_handle || (m.insight_id ? `INS-${String(m.insight_id).slice(-6).toUpperCase()}` : "");
  const releaseTag = m.release_tag || "release";

  return (
    <div className="card corner">
      <div className="row-between" style={{ alignItems: "flex-start" }}>
        <span className="lbl" style={{ margin: 0 }}>
          Proposed match
        </span>
        <Tooltip title={`Confidence ${conf}`} content={meaning.tip}>
          <span className={confidenceClass(conf)}>
            {meaning.label} · {conf}
          </span>
        </Tooltip>
      </div>

      {/* Lifecycle as a time-spine: what the client said -> what shipped -> telling them.
          The release is the proven 'Shipped' tick (done, amber); 'Client told' is the live
          next step that confirming this match unlocks. */}
      <Spine className="proof-spine">
        <SpineItem state="done">
          <div className="lbl" style={{ margin: "0 0 4px" }}>
            What the client asked for
          </div>
          <div style={{ fontSize: 13.5, lineHeight: 1.45 }}>{m.insight_title || "Untitled ask"}</div>
          {handle && (
            <div className="mono subtle" style={{ fontSize: 11, marginTop: 6 }}>
              {handle}
            </div>
          )}
        </SpineItem>

        <SpineItem
          state="done"
          timecode={m.release_published_at ? formatDate(m.release_published_at) : undefined}
        >
          <div className="lbl" style={{ margin: "0 0 4px" }}>
            Shipped
          </div>
          <div className="row" style={{ gap: 8, marginBottom: 6 }}>
            <span className="pill feat">{releaseTag}</span>
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.45 }}>
            {m.entry_title || m.entry_text || "Release entry"}
          </div>
        </SpineItem>

        <SpineItem state="live">
          <div className="lbl" style={{ margin: "0 0 4px" }}>
            Client told
          </div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.45 }}>
            Confirm this match to mark the ask shipped. The client can then be told.
          </div>
        </SpineItem>
      </Spine>

      {m.rationale && (
        <div className="aibox">
          <b>Why the AI matched these:</b> {m.rationale}
        </div>
      )}

      {quotes.length > 0 && (
        <>
          <div className="lbl">Proof from the release note</div>
          <PaperBand className="proof-evidence">
            <div className="stack-sm">
              {quotes.map((q, i) => (
                <TestimonyQuote key={i} quote={q} speaker={releaseTag} timecode={m.release_published_at ? formatDate(m.release_published_at) : null} />
              ))}
            </div>
          </PaperBand>
        </>
      )}

      <div className="actions" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, alignItems: "center" }}>
        <Btn
          variant="primary"
          onClick={onConfirm}
          disabled={busy}
          tooltip="Marks the ask shipped and records that this release delivered it. The client can then be told."
          tooltipTitle="Confirm shipped"
        >
          {busy ? "Working" : "Confirm shipped"}
        </Btn>
        <Btn
          variant="danger"
          onClick={onRejectOpen}
          disabled={busy}
          tooltip="This release does not cover the ask. The ask stays open for a future match."
          tooltipTitle="Reject"
        >
          Reject
        </Btn>
      </div>
    </div>
  );
}

function ReleasesTab({
  releases,
  error,
  tokenConfigured,
  onRetry,
}: {
  releases: Release[] | null;
  error: unknown;
  tokenConfigured: boolean;
  onRetry: () => void;
}) {
  const rows = useMemo(() => releases ?? [], [releases]);

  if (error && rows.length === 0) {
    return <ErrorAlert error={error} onRetry={onRetry} />;
  }
  if (releases === null) {
    return <Skeleton rows={6} />;
  }
  if (rows.length === 0) {
    if (!tokenConfigured) {
      return (
        <EmptyState
          title="GitHub is not connected yet"
          body="The release repo is private, so pulling needs a read-only GitHub token. Add GITHUB_READ_TOKEN to the server's .env and restart; releases then pull automatically every hour."
        />
      );
    }
    return (
      <EmptyState
        title="No releases yet"
        body="Releases pull automatically every hour. An admin can also pull right now from the Settings page."
      />
    );
  }
  return (
    <div className="card" style={{ padding: 0 }}>
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
  );
}
