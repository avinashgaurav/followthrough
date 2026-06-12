import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { QueueItem } from "../api";
import { useAuth } from "../auth";
import { useListSelection } from "../components/shortcuts";
import {
  Btn,
  EmptyState,
  ErrorAlert,
  ItemTypePill,
  Skeleton,
  Tooltip,
} from "../components/ui";
import { ageOf, relativeAge } from "../format";
import { InsightDetailView } from "./InsightDetail";

// Job: decide what each insight is and polish it before it moves.
// Two-pane triage screen: left = the queue (GET /api/queue) in plain-language buckets,
// grouped by client and ordered oldest-first so the wall of cards has a priority signal;
// right = the shared InsightDetailView (also used by the full-page route), embedded.
// One detail component, no drift (see design-reference/SPINE.md and the design audit A2).

// The five queue buckets, in pipeline order, in words a founder gets instantly.
const BUCKETS: Array<{ key: keyof QueueBuckets; label: string; tip: string }> = [
  {
    key: "to_review",
    label: "New from AI - needs your eyes",
    tip: "The AI pulled these from meetings. Nobody has checked them yet.",
  },
  {
    key: "to_finalize",
    label: "Routed - needs final wording",
    tip: "Routed and owned, but the wording is not locked. Polish it, then lock it.",
  },
  {
    key: "to_ticket",
    label: "Ready for a ticket",
    tip: "Wording is locked. Draft a ticket so engineering can build it.",
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

/** Best-effort age in days, for oldest-first ordering and the priority signal. */
function ageDays(it: QueueItem): number {
  if (typeof it.age_days === "number") return it.age_days;
  const t = it.updated_at || it.created_at;
  if (typeof t === "string") {
    const ms = Date.now() - new Date(t).getTime();
    if (!Number.isNaN(ms)) return Math.max(0, ms / 86_400_000);
  }
  return 0;
}

interface ClientGroup {
  client: string;
  items: QueueItem[];
}
interface BucketGroup {
  bucket: (typeof BUCKETS)[number];
  groups: ClientGroup[];
  count: number;
}

export function Review() {
  const { user } = useAuth();

  const [buckets, setBuckets] = useState<QueueBuckets | null>(null);
  const [orgCounts, setOrgCounts] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadQueue = useCallback((opts: { keepSelection?: boolean } = {}) => {
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
        setOrgCounts(
          (q.org_counts as Record<string, unknown>) ||
            (q.org as Record<string, unknown>) ||
            null,
        );
        setLoading(false);
        if (!opts.keepSelection) {
          const first = BUCKETS.flatMap((bk) => b[bk.key]).map(itemId).find(Boolean);
          setSelectedId((cur) => cur ?? first ?? null);
        }
      })
      .catch((e) => {
        setError(e);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  // Group each bucket by client, items oldest-first, most-urgent client first.
  const grouped = useMemo<BucketGroup[]>(() => {
    if (!buckets) return [];
    const out: BucketGroup[] = [];
    for (const bucket of BUCKETS) {
      const items = [...buckets[bucket.key]].sort((a, b) => ageDays(b) - ageDays(a));
      if (items.length === 0) continue;
      const byClient = new Map<string, QueueItem[]>();
      for (const it of items) {
        const c = it.client_name || "Unknown client";
        const arr = byClient.get(c);
        if (arr) arr.push(it);
        else byClient.set(c, [it]);
      }
      out.push({
        bucket,
        count: items.length,
        groups: [...byClient.entries()].map(([client, its]) => ({ client, items: its })),
      });
    }
    return out;
  }, [buckets]);

  // Flatten in exact render order for j/k navigation.
  const flat = useMemo(() => {
    const out: Array<{ item: QueueItem; bucket: keyof QueueBuckets }> = [];
    for (const g of grouped)
      for (const grp of g.groups)
        for (const it of grp.items) out.push({ item: it, bucket: g.bucket.key });
    return out;
  }, [grouped]);

  // The single most-urgent (oldest) item in each bucket gets a priority marker.
  const priorityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const g of grouped) {
      const top = g.groups[0]?.items[0];
      if (top) ids.add(itemId(top));
    }
    return ids;
  }, [grouped]);

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
        window.requestAnimationFrame(() => {
          document
            .querySelector<HTMLElement>(".detail textarea, .detail [contenteditable='true']")
            ?.focus();
        });
      }
    },
    flat.length > 0,
  );

  // Two-way sync between selectedId (clicks) and index (j/k), guarded so they don't ping-pong.
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

  return (
    <>
      <div className="head">
        <div className="row-between">
          <div>
            <h1>Review</h1>
            <p>Decide what each ask is and polish it before it moves.</p>
          </div>
          <div className="row">
            {totalCount > 0 && (
              <Tooltip content="Everything waiting on you across all five buckets.">
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
        {user?.role === "admin" && orgCounts && <OrgStrip counts={orgCounts} />}
      </div>

      <div className="split">
        <div className="queue" role="listbox" aria-label="Review queue">
          {loading && !buckets ? (
            <div style={{ padding: 16 }}>
              <Skeleton rows={8} />
            </div>
          ) : error ? (
            <div style={{ padding: 16 }}>
              <ErrorAlert error={error} onRetry={() => loadQueue()} />
            </div>
          ) : totalCount === 0 ? (
            <div style={{ padding: 16 }}>
              <EmptyState
                title="Nothing waiting."
                body="When the AI pulls new asks from a meeting, they line up here for your review."
              />
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.bucket.key}>
                <div className="qgroup">
                  <Tooltip content={g.bucket.tip}>
                    <span>{g.bucket.label}</span>
                  </Tooltip>
                  <span className="n">{g.count}</span>
                </div>
                {g.groups.map((grp) => (
                  <div key={grp.client}>
                    <div className="qclient">
                      <span className="mono tiny subtle">{grp.client}</span>
                      {grp.items.length > 1 && (
                        <span className="mono tiny subtle">{grp.items.length}</span>
                      )}
                    </div>
                    {grp.items.map((it) => {
                      const id = itemId(it);
                      const itemType = typeof it.item_type === "string" ? it.item_type : "";
                      const isPriority = priorityIds.has(id);
                      return (
                        <button
                          type="button"
                          key={id || it.handle}
                          className={`lcard${id === selectedId ? " sel" : ""}`}
                          aria-selected={id === selectedId}
                          onClick={() => setSelectedId(id)}
                        >
                          <div className="t">{it.title || "Untitled ask"}</div>
                          <div className="meta">
                            {isPriority && (
                              <Tooltip content="The longest-waiting ask in this bucket. Start here.">
                                <span className="mono tiny" style={{ color: "var(--signal)" }}>
                                  oldest
                                </span>
                              </Tooltip>
                            )}
                            {itemType && <ItemTypePill type={itemType} />}
                            <span className="mono">
                              {relativeAge(
                                typeof it.age_days === "number" ? it.age_days : undefined,
                              ) ||
                                ageOf(it.updated_at || it.created_at) ||
                                "today"}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {selectedId ? (
          <InsightDetailView
            key={selectedId}
            insightId={selectedId}
            embedded
            onChanged={() => loadQueue({ keepSelection: true })}
          />
        ) : (
          <div className="detail corner">
            {!loading && (
              <EmptyState
                title="Pick something on the left."
                body="Select an ask to read what the client said, polish the wording, and route it."
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- admin org strip

function OrgStrip({ counts }: { counts: Record<string, unknown> }) {
  const entries = Object.entries(counts).filter(([, v]) => typeof v === "number");
  if (entries.length === 0) return null;
  return (
    <div className="org-strip">
      <Tooltip content="Across the whole team, not just your own queue.">
        <span className="lbl">Org-wide</span>
      </Tooltip>
      {entries.map(([k, v]) => (
        <span key={k} className="org-stat">
          <span className="mono num">{String(v)}</span>
          <span className="subtle tiny">{k.replaceAll("_", " ")}</span>
        </span>
      ))}
      <style>{`
        .org-strip { display:flex; align-items:center; gap:14px; margin-top:10px; flex-wrap:wrap; }
        .org-stat { display:inline-flex; align-items:baseline; gap:5px; }
        .org-stat .num { font-size:13px; color:var(--ink); }
      `}</style>
    </div>
  );
}
