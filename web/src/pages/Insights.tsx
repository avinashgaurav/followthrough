import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ITEM_TYPES, STATES, TRACKS } from "../api";
import type { Client, Insight, SearchResponse } from "../api";
import {
  Btn,
  Combobox,
  EmptyState,
  ErrorAlert,
  ItemTypePill,
  SectionHead,
  Skeleton,
  StatePill,
  Tooltip,
} from "../components/ui";
import { ageOf, itemTypeLabel, relativeAge, stateLabel, trackLabel } from "../format";

// Job: everything we have learned, searchable.
// Master table over GET /api/insights with a filter bar (state, track, client, item type)
// and a search box that calls GET /api/search and links straight to a hit.
// Default sort: priority high to low, then oldest first.

// State buckets the founder filters by, in pipeline order. "All" clears the filter.
const STATE_FILTERS: Array<{ value: string; label: string; tip: string }> = [
  { value: "", label: "All", tip: "Show insights in any state." },
  ...STATES.filter((s) => s !== "merged").map((s) => ({
    value: s,
    label: stateLabel(s),
    tip: `Only insights that are ${stateLabel(s).toLowerCase()}.`,
  })),
];

const TRACK_FILTERS: Array<{ value: string; label: string; tip: string }> = [
  { value: "", label: "All tracks", tip: "Show insights routed to any track." },
  ...TRACKS.map((t) => ({
    value: t,
    label: trackLabel(t),
    tip: `Only insights routed to ${trackLabel(t).toLowerCase()}.`,
  })),
];

type SortKey = "priority" | "age";

function priorityOf(i: Insight): number {
  return typeof i.priority === "number" ? i.priority : -1;
}

function ageDaysOf(i: Insight): number {
  if (typeof i.age_days === "number") return i.age_days;
  const iso = i.created_at;
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

function ageLabelOf(i: Insight): string {
  if (typeof i.age_days === "number") return relativeAge(i.age_days);
  return ageOf(i.created_at) || "today";
}

/** Small segmented control. Each segment carries its own tooltip. */
function Segmented({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<{ value: string; label: string; tip: string }>;
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
}) {
  return (
    <div className="seg" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <Tooltip key={o.value || "all"} content={o.tip}>
          <button
            type="button"
            className={`seg-btn${value === o.value ? " on" : ""}`}
            aria-pressed={value === o.value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

export function Insights() {
  const navigate = useNavigate();

  // filter state
  const [stateFilter, setStateFilter] = useState("");
  const [trackFilter, setTrackFilter] = useState("");
  const [itemTypeFilter, setItemTypeFilter] = useState("");
  const [client, setClient] = useState<Client | null>(null);
  const [clients, setClients] = useState<Client[]>([]);

  // table sort
  const [sortKey, setSortKey] = useState<SortKey>("priority");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // data
  const [rows, setRows] = useState<Insight[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  // search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResult, setSearchResult] = useState<SearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  useEffect(() => {
    let live = true;
    api
      .listClients()
      .then((cs) => {
        if (live) setClients(cs);
      })
      .catch(() => {
        /* client filter is optional; ignore load failure */
      });
    return () => {
      live = false;
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listInsights({
        state: stateFilter || undefined,
        track: trackFilter || undefined,
        client_id: client?.id,
        item_type: itemTypeFilter || undefined,
      })
      .then((r) => {
        setRows(r);
        setLoading(false);
      })
      .catch((e) => {
        setError(e);
        setLoading(false);
      });
  }, [stateFilter, trackFilter, itemTypeFilter, client]);

  useEffect(() => {
    load();
  }, [load]);

  // Debounced search against GET /api/search. Empty query clears results.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchResult(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const seq = ++searchSeq.current;
    const handle = window.setTimeout(() => {
      api
        .search(q, {
          state: stateFilter || undefined,
          track: trackFilter || undefined,
          client_id: client?.id,
        })
        .then((r) => {
          if (seq === searchSeq.current) {
            setSearchResult(r);
            setSearching(false);
          }
        })
        .catch(() => {
          if (seq === searchSeq.current) {
            setSearchResult({ insights: [], transcripts: [] });
            setSearching(false);
          }
        });
    }, 250);
    return () => window.clearTimeout(handle);
  }, [searchQuery, stateFilter, trackFilter, client]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp: number;
      if (sortKey === "priority") {
        cmp = priorityOf(b) - priorityOf(a); // high priority first by default
        if (cmp === 0) cmp = ageDaysOf(b) - ageDaysOf(a); // then oldest first
      } else {
        cmp = ageDaysOf(b) - ageDaysOf(a); // oldest first by default
      }
      return sortDir === "desc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function openInsight(id?: string) {
    if (id) navigate(`/insights/${encodeURIComponent(id)}`);
  }

  const anyFilterActive =
    !!stateFilter || !!trackFilter || !!itemTypeFilter || !!client || !!searchQuery.trim();

  function clearAll() {
    setStateFilter("");
    setTrackFilter("");
    setItemTypeFilter("");
    setClient(null);
    setSearchQuery("");
  }

  const sortArrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "desc" ? " ↓" : " ↑") : "";

  return (
    <>
      <SectionHead
        title="Insights"
        job="Everything we have learned, searchable."
        actions={
          anyFilterActive ? (
            <Btn
              size="sm"
              variant="ghost"
              onClick={clearAll}
              tooltip="Remove every filter and the search text."
            >
              Clear filters
            </Btn>
          ) : undefined
        }
      />

      <div className="scroll">
        <div className="page-body stack">
          {/* filter bar */}
          <div className="filter-bar">
            <div className="filter-row">
              <span className="lbl filter-lbl">State</span>
              <Segmented
                options={STATE_FILTERS}
                value={stateFilter}
                onChange={setStateFilter}
                ariaLabel="Filter by state"
              />
            </div>

            <div className="filter-row">
              <span className="lbl filter-lbl">Track</span>
              <Segmented
                options={TRACK_FILTERS}
                value={trackFilter}
                onChange={setTrackFilter}
                ariaLabel="Filter by track"
              />
            </div>

            <div className="filter-row filter-row-controls">
              <label className="field filter-field">
                <span className="lbl">Client</span>
                <Combobox<Client>
                  items={clients}
                  value={client}
                  onChange={setClient}
                  getKey={(c) => c.id}
                  getLabel={(c) => c.name}
                  placeholder="Any client"
                />
              </label>

              <label className="field filter-field">
                <span className="lbl">Type</span>
                <Tooltip content="Narrow to one kind of insight, like a feature request or a complaint.">
                  <select
                    className="ctrl"
                    value={itemTypeFilter}
                    onChange={(e) => setItemTypeFilter(e.target.value)}
                    aria-label="Filter by type"
                  >
                    <option value="">Any type</option>
                    {ITEM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {itemTypeLabel(t)}
                      </option>
                    ))}
                  </select>
                </Tooltip>
              </label>

              <label className="field filter-field filter-field-grow">
                <span className="lbl">Search</span>
                <Tooltip content="Searches insight wording and meeting transcripts. Pick a result to jump straight to it.">
                  <input
                    className="ctrl"
                    type="search"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search insights and transcripts"
                    aria-label="Search insights and transcripts"
                  />
                </Tooltip>
              </label>
            </div>
          </div>

          {/* search results take over when a query is present */}
          {searchQuery.trim() ? (
            <SearchResults
              query={searchQuery.trim()}
              searching={searching}
              result={searchResult}
              onOpenInsight={openInsight}
            />
          ) : loading ? (
            <div className="card">
              <Skeleton rows={8} />
            </div>
          ) : error ? (
            <ErrorAlert error={error} onRetry={load} />
          ) : sorted.length === 0 ? (
            <EmptyState
              title={anyFilterActive ? "Nothing matches those filters." : "No insights yet."}
              body={
                anyFilterActive
                  ? "Loosen a filter to see more, or clear them all."
                  : "Once you capture a meeting and run the extract, every insight shows up here."
              }
              action={
                anyFilterActive ? (
                  <Btn variant="primary" onClick={clearAll}>
                    Clear filters
                  </Btn>
                ) : (
                  <Btn variant="primary" onClick={() => navigate("/capture")}>
                    Capture a meeting
                  </Btn>
                )
              }
            />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Client</th>
                    <th>Ask</th>
                    <th>Track</th>
                    <th>State</th>
                    <th>
                      <Tooltip content="Sort by how long this has waited. Click to flip the order.">
                        <button type="button" className="th-sort" onClick={() => toggleSort("age")}>
                          Age{sortArrow("age")}
                        </button>
                      </Tooltip>
                    </th>
                    <th className="num">
                      <Tooltip
                        title="Priority"
                        content="How important this insight is. Higher means handle it sooner. Click to flip the order."
                      >
                        <button
                          type="button"
                          className="th-sort"
                          onClick={() => toggleSort("priority")}
                        >
                          Priority{sortArrow("priority")}
                        </button>
                      </Tooltip>
                    </th>
                    <th>Ref</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((i) => {
                    const id = i.id;
                    const handle = i.handle || (id ? `INS-${id.slice(-6).toUpperCase()}` : "");
                    return (
                      <tr
                        key={id || handle}
                        className="clickable"
                        onClick={() => openInsight(id)}
                        tabIndex={0}
                        role="link"
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openInsight(id);
                          }
                        }}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{i.client_name || "Unknown client"}</div>
                          {i.meeting_seq != null && (
                            <div className="mono tiny subtle" style={{ marginTop: 2 }}>
                              meeting {String(i.meeting_seq)}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <span>{i.title || "Untitled insight"}</span>
                            {i.item_type && <ItemTypePill type={i.item_type} />}
                          </div>
                        </td>
                        <td className="muted">{trackLabel(i.track)}</td>
                        <td>
                          <StatePill state={i.state} />
                        </td>
                        <td className="mono tiny muted">{ageLabelOf(i)}</td>
                        <td className="num">
                          {typeof i.priority === "number" ? i.priority : "-"}
                        </td>
                        <td className="mono tiny subtle">{handle}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* page-scoped styles for the filter bar + segmented control + sort headers */}
      <style>{INSIGHTS_CSS}</style>
    </>
  );
}

// ---------------------------------------------------------------- search results

function SearchResults({
  query,
  searching,
  result,
  onOpenInsight,
}: {
  query: string;
  searching: boolean;
  result: SearchResponse | null;
  onOpenInsight: (id?: string) => void;
}) {
  const navigate = useNavigate();

  if (searching && !result) {
    return (
      <div className="card">
        <Skeleton rows={5} />
      </div>
    );
  }

  const insights = result?.insights ?? [];
  const transcripts = result?.transcripts ?? [];

  if (insights.length === 0 && transcripts.length === 0) {
    return (
      <EmptyState
        title={`Nothing found for "${query}".`}
        body="Try fewer words, or check a different client. Clearing the search shows the full table again."
      />
    );
  }

  return (
    <div className="stack">
      {insights.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 8 }}>
            Matching insights ({insights.length})
          </div>
          <div className="search-list">
            {insights.map((hit, idx) => (
              <button
                type="button"
                key={hit.id || idx}
                className="lcard"
                onClick={() => onOpenInsight(hit.id)}
              >
                <div className="t">{hit.title || "Untitled insight"}</div>
                <div className="meta">
                  {hit.handle && <span className="mono tiny subtle">{hit.handle}</span>}
                  {hit.client_name && <span>{hit.client_name}</span>}
                </div>
                {hit.snippet && (
                  <div className="snippet" dangerouslySetInnerHTML={highlight(hit.snippet)} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {transcripts.length > 0 && (
        <div>
          <div className="lbl" style={{ marginBottom: 8 }}>
            Found in transcripts ({transcripts.length})
          </div>
          <div className="search-list">
            {transcripts.map((hit, idx) => (
              <button
                type="button"
                key={hit.meeting_id || idx}
                className="lcard"
                onClick={() =>
                  hit.meeting_id &&
                  navigate(`/capture?meeting=${encodeURIComponent(hit.meeting_id)}`)
                }
              >
                <div className="t">{hit.title || hit.client_name || "Meeting transcript"}</div>
                <div className="meta">
                  {hit.client_name && <span>{hit.client_name}</span>}
                  <span className="subtle">opens the meeting</span>
                </div>
                {hit.snippet && (
                  <div className="snippet" dangerouslySetInnerHTML={highlight(hit.snippet)} />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// The search snippet may contain server-provided <mark> tags. Escape everything else
// and only allow <mark>...</mark> through, so we never inject arbitrary HTML.
function highlight(snippet: string): { __html: string } {
  const escaped = snippet
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const withMarks = escaped
    .replaceAll("&lt;mark&gt;", "<mark>")
    .replaceAll("&lt;/mark&gt;", "</mark>");
  return { __html: withMarks };
}

const INSIGHTS_CSS = `
.filter-bar {
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--p1);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.filter-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.filter-row-controls {
  align-items: flex-end;
}
.filter-lbl {
  min-width: 46px;
  flex: 0 0 auto;
}
.filter-field {
  min-width: 180px;
}
.filter-field-grow {
  flex: 1 1 220px;
}
.seg {
  display: inline-flex;
  border: 1px solid var(--line);
  border-radius: var(--r);
  overflow: hidden;
  flex-wrap: wrap;
}
.seg-btn {
  font-family: var(--font);
  font-size: 11.5px;
  padding: 5px 10px;
  background: transparent;
  color: var(--ink-muted);
  border: none;
  border-right: 1px solid var(--line);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.seg-btn:last-child {
  border-right: none;
}
.seg-btn:hover {
  background: var(--p2);
  color: var(--ink);
}
.seg-btn.on {
  background: var(--accent);
  color: var(--accent-ink);
  font-weight: 600;
}
.th-sort {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--ink-subtle);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.th-sort:hover {
  color: var(--accent-soft);
}
.search-list {
  border: 1px solid var(--line);
  border-radius: var(--r);
  overflow: hidden;
  background: var(--p1);
}
.search-list .lcard {
  border-bottom: 1px solid var(--line-soft);
}
.search-list .lcard:last-child {
  border-bottom: none;
}
.snippet {
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-muted);
  line-height: 1.55;
}
.snippet mark {
  background: var(--signal-wash);
  color: var(--accent-soft);
  border-radius: 1px;
  padding: 0 1px;
}
`;
