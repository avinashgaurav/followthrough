import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MetricsOverview } from "../api";
import { fmtNum, metricTooltipFor, relativeAge, titleCase, trackLabel } from "../format";
import { Alert, Btn, EmptyState, ErrorAlert, Help, SectionHead, Skeleton, Sparkline, Tooltip } from "../components/ui";

// Admin. Job: how fast asks move from meeting to shipped to told.
// Data: api.metricsOverview(). Rendered as dense tables + CSS bars, no chart libraries.
// The wrapper types this as Record<string, unknown> (field drift expected), so every
// accessor below is defensive and never throws on a missing shape.

// ---------------------------------------------------------------- safe readers

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function arr(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.map((x) => obj(x));
  // some shapes nest the array under a key
  const o = obj(v);
  for (const k of ["items", "rows", "data", "list", "buckets"]) {
    if (Array.isArray(o[k])) return (o[k] as unknown[]).map((x) => obj(x));
  }
  return [];
}
function num(v: unknown): number | null {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}
/** Pick the first present value across candidate keys. */
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

interface Stat {
  avg: number | null;
  median: number | null;
  p90: number | null;
  n: number | null;
}
function readStat(v: unknown): Stat {
  const o = obj(v);
  return {
    avg: num(pick(o, "avg", "average", "mean")),
    median: num(pick(o, "median", "p50", "med")),
    p90: num(pick(o, "p90", "p_90", "ninetieth")),
    n: num(pick(o, "n", "count", "sample", "samples")),
  };
}
function isEmptyStat(s: Stat): boolean {
  return s.avg === null && s.median === null && s.p90 === null && (s.n === null || s.n === 0);
}

/** Days -> human duration, e.g. "today", "3d", "2w". Stat values are stored as days. */
function dur(v: number | null): string {
  if (v === null) return "-";
  if (v < 0.5) return "<1d";
  return relativeAge(v);
}

// the canonical stage-pair columns in pipeline order
const STAGE_PAIRS: { key: string; label: string }[] = [
  { key: "extracted_to_finalized", label: "Found → Locked" },
  { key: "finalized_to_ticketed", label: "Locked → Ticketed" },
  { key: "ticketed_to_shipped", label: "Ticketed → Shipped" },
  { key: "finalized_to_shipped", label: "Locked → Shipped" },
  { key: "shipped_to_notified", label: "Shipped → Told" },
  { key: "end_to_end", label: "Meeting → Told" },
];

// ---------------------------------------------------------------- small layout helpers

function MetricLabel({ k, children }: { k: string; children: React.ReactNode }) {
  const tip = metricTooltipFor(k);
  if (!tip) return <>{children}</>;
  return (
    <Tooltip title={titleCase(k)} content={tip}>
      <span style={{ cursor: "help" }}>{children}</span>
    </Tooltip>
  );
}

function Section({ title, tip, children }: { title: string; tip?: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, display: "flex", alignItems: "center", gap: 7 }}>
        <span className="lbl" style={{ margin: 0, fontSize: 9.5 }}>
          {title}
        </span>
        {tip && <Help content={tip} title={title} />}
      </h2>
      {children}
    </section>
  );
}

/** Horizontal CSS bar (transform-free, just width). */
function Bar({ value, max, label, sub }: { value: number; max: number; label: string; sub?: string }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="row-between" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 12 }}>{label}</span>
        <span className="num muted" style={{ fontSize: 12 }}>
          {sub ?? fmtNum(value)}
        </span>
      </div>
      <div style={{ height: 8, background: "var(--p2)", border: "1px solid var(--line)", borderRadius: "var(--r)" }}>
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "var(--accent)",
            borderRadius: "var(--r)",
            transition: "width var(--dur-med) var(--ease-out)",
          }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- page

export function Numbers() {
  const [data, setData] = useState<MetricsOverview | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.metricsOverview());
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <SectionHead
        title="Numbers"
        job="How fast asks move from meeting to shipped to told."
        actions={
          <Btn
            size="sm"
            variant="ghost"
            onClick={() => void load()}
            tooltip="Re-pull the latest counts and turnaround times."
          >
            Refresh
          </Btn>
        }
      />
      <div className="page-body">
        {error ? (
          <ErrorAlert error={error} onRetry={() => void load()} />
        ) : data === null ? (
          <Skeleton rows={10} />
        ) : (
          <MetricsBody data={data} />
        )}
      </div>
    </>
  );
}

function MetricsBody({ data }: { data: MetricsOverview }) {
  const root = obj(data);

  const stageTats = arr(pick(root, "stageTats", "stage_tats", "stages"));
  const funnel = useMemo(() => readFunnel(pick(root, "funnel")), [root]);
  const wip = obj(pick(root, "wipAndAging", "wip_and_aging", "wip"));
  const stuck = arr(pick(root, "stuckItems", "stuck_items", "stuck"));
  const theme = arr(pick(root, "themeDemand", "theme_demand", "themes"));
  const perPerson = arr(pick(root, "perPerson", "per_person", "people"));
  const perClient = arr(pick(root, "perClientClosedLoop", "per_client_closed_loop", "perClient"));
  const aiQuality = obj(pick(root, "aiQuality", "ai_quality"));
  const capture = arr(pick(root, "captureVolume", "capture_volume", "capture"));

  const nothing =
    stageTats.length === 0 &&
    funnel.length === 0 &&
    stuck.length === 0 &&
    theme.length === 0 &&
    perPerson.length === 0 &&
    perClient.length === 0 &&
    capture.length === 0 &&
    Object.keys(wip).length === 0 &&
    Object.keys(aiQuality).length === 0;

  if (nothing) {
    return (
      <EmptyState
        title="Not enough data yet"
        body="Once a few asks move through the pipeline, turnaround times and the funnel will show up here."
      />
    );
  }

  return (
    <>
      <StageTats stageTats={stageTats} />
      <Funnel rows={funnel} />
      <WipAging wip={wip} />
      <StuckItems items={stuck} />
      <ThemeDemand rows={theme} />
      <PerPerson rows={perPerson} />
      <PerClient rows={perClient} />
      <AiQuality data={aiQuality} />
      <CaptureVolume rows={capture} />
    </>
  );
}

// ---------------------------------------------------------------- stage turnaround times

function StageTats({ stageTats }: { stageTats: Record<string, unknown>[] }) {
  if (stageTats.length === 0) return null;
  return (
    <Section title="Turnaround time by stage" tip={metricTooltipFor("turnaround")}>
      <p className="muted small" style={{ margin: "0 0 12px" }}>
        Middle value shown in each cell. Hover a number for the average and the slow-tail (90 percent
        finished within).
      </p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Track</th>
              {STAGE_PAIRS.map((p) => (
                <th key={p.key} className="num">
                  <MetricLabel k={p.key}>{p.label}</MetricLabel>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {stageTats.map((row, i) => (
              <tr key={i}>
                <td>{trackLabel(str(pick(row, "track", "name")))}</td>
                {STAGE_PAIRS.map((p) => {
                  const s = readStat(row[p.key]);
                  if (isEmptyStat(s)) {
                    return (
                      <td key={p.key} className="num subtle">
                        -
                      </td>
                    );
                  }
                  return (
                    <td key={p.key} className="num">
                      <Tooltip
                        title={p.label}
                        content={
                          <span>
                            Average {dur(s.avg)} · 90% within {dur(s.p90)} · based on {s.n ?? 0} items
                          </span>
                        }
                      >
                        <span style={{ cursor: "help" }}>{dur(s.median)}</span>
                      </Tooltip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- funnel

interface FunnelRow {
  label: string;
  count: number;
}
function readFunnel(v: unknown): FunnelRow[] {
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        const o = obj(x);
        return {
          label: str(pick(o, "label", "stage", "name", "state")),
          count: num(pick(o, "count", "n", "value")) ?? 0,
        };
      })
      .filter((r) => r.label);
  }
  // object form: { extracted: 40, finalized: 22, ... }
  const o = obj(v);
  return Object.entries(o)
    .filter(([, val]) => num(val) !== null)
    .map(([k, val]) => ({ label: titleCase(k), count: num(val) ?? 0 }));
}

function Funnel({ rows }: { rows: FunnelRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <Section title="Funnel" tip={metricTooltipFor("funnel")}>
      {rows.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <Sparkline values={rows.map((r) => r.count)} title="Count by funnel stage, in pipeline order" />
        </div>
      )}
      {rows.map((r, i) => (
        <Bar key={i} label={titleCase(r.label)} value={r.count} max={max} sub={fmtNum(r.count)} />
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------- WIP + aging

function WipAging({ wip }: { wip: Record<string, unknown> }) {
  if (Object.keys(wip).length === 0) return null;

  // WIP by-state counts may live under a key or be the object itself
  const byState = obj(pick(wip, "byState", "by_state", "wip", "counts"));
  const stateRows = Object.entries(byState)
    .map(([k, v]) => ({ k: titleCase(k), v: num(v) }))
    .filter((r) => r.v !== null) as { k: string; v: number }[];

  const totalWip = num(pick(wip, "total", "wip_total", "in_flight"));
  const oldest = num(pick(wip, "oldest_days", "oldestDays", "oldest"));

  // aging buckets, if present
  const buckets = arr(pick(wip, "aging", "buckets", "agingBuckets", "aging_buckets"));

  return (
    <Section title="Work in flight and aging" tip={metricTooltipFor("wipAndAging")}>
      <div className="grid-auto" style={{ marginBottom: 14 }}>
        {totalWip !== null && (
          <div className="stat">
            <div className="v">{fmtNum(totalWip)}</div>
            <div className="k lbl" style={{ margin: 0 }}>
              <MetricLabel k="wipAndAging">In flight now</MetricLabel>
            </div>
          </div>
        )}
        {oldest !== null && (
          <div className="stat">
            <div className="v">{dur(oldest)}</div>
            <div className="k lbl" style={{ margin: 0 }}>
              <MetricLabel k="oldestOpenItem">Oldest open item</MetricLabel>
            </div>
          </div>
        )}
        {stateRows.map((r) => (
          <div className="stat" key={r.k}>
            <div className="v">{fmtNum(r.v)}</div>
            <div className="k lbl" style={{ margin: 0 }}>
              {r.k}
            </div>
          </div>
        ))}
      </div>
      {buckets.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <Sparkline
            values={buckets.map((b) => num(pick(b, "count", "n", "items")) ?? 0)}
            highlightLast={false}
            title="Open items per age bucket, oldest at right"
          />
        </div>
      )}
      {buckets.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Age bucket</th>
                <th className="num">Items</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) => (
                <tr key={i}>
                  <td>{str(pick(b, "label", "bucket", "range", "name")) || "-"}</td>
                  <td className="num">{fmtNum(num(pick(b, "count", "n", "items")) ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- stuck items

function StuckItems({ items }: { items: Record<string, unknown>[] }) {
  if (items.length === 0) return null;
  return (
    <Section title="Stuck and needs a nudge" tip={metricTooltipFor("stuckItems")}>
      <Alert severity="warning" title={`${items.length} item${items.length === 1 ? "" : "s"} have not moved in a while`}>
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {items.map((it, i) => {
            const title = str(pick(it, "title", "insight_title", "name")) || "Untitled";
            const state = str(pick(it, "state", "current_state"));
            const age = num(pick(it, "age_days", "ageDays", "days_in_state", "age"));
            const client = str(pick(it, "client_name", "client"));
            return (
              <li key={i} style={{ marginBottom: 4 }}>
                {title}
                {client && <span className="subtle"> · {client}</span>}
                {state && <span className="subtle"> · {titleCase(state)}</span>}
                {age !== null && <span className="subtle"> · stuck {dur(age)}</span>}
              </li>
            );
          })}
        </ul>
      </Alert>
    </Section>
  );
}

// ---------------------------------------------------------------- theme demand

function ThemeDemand({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const norm = rows.map((r) => ({
    tag: str(pick(r, "tag", "theme", "name", "label")),
    clients: num(pick(r, "client_count", "clients", "client_n", "clientCount")) ?? 0,
    mentions: num(pick(r, "mention_count", "mentions", "count", "n")),
  }));
  const max = Math.max(...norm.map((r) => r.clients), 1);
  return (
    <Section title="What clients ask for most" tip={metricTooltipFor("themeDemand")}>
      {norm.length > 1 && (
        <div style={{ marginBottom: 14 }}>
          <Sparkline
            values={norm.map((r) => r.clients)}
            highlightLast={false}
            title="Distinct clients asking, by theme"
          />
        </div>
      )}
      {norm.map((r, i) => (
        <Bar
          key={i}
          label={r.tag || "untagged"}
          value={r.clients}
          max={max}
          sub={`${fmtNum(r.clients)} client${r.clients === 1 ? "" : "s"}${
            r.mentions !== null ? ` · ${fmtNum(r.mentions)} mentions` : ""
          }`}
        />
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------- per person

function PerPerson({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title="Per person" tip={metricTooltipFor("perPerson")}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">
                <Tooltip title="Owns" content="How many items this person currently owns.">
                  <span>Owns</span>
                </Tooltip>
              </th>
              <th className="num">
                <Tooltip title="Locked" content="How many they locked the wording on.">
                  <span>Locked</span>
                </Tooltip>
              </th>
              <th className="num">
                <Tooltip title="Shipped" content="How many of their items engineering shipped.">
                  <span>Shipped</span>
                </Tooltip>
              </th>
              <th className="num">
                <Tooltip title="Median turnaround" content="Their middle time to move an item along.">
                  <span>Median TAT</span>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{str(pick(r, "name", "person", "user_name", "assignee_name")) || "Unassigned"}</td>
                <td className="num">{fmtNum(num(pick(r, "owns", "owned", "open", "wip")) ?? 0)}</td>
                <td className="num">{fmtNum(num(pick(r, "finalized", "locked")) ?? 0)}</td>
                <td className="num">{fmtNum(num(pick(r, "shipped")) ?? 0)}</td>
                <td className="num">{dur(num(pick(r, "median_tat", "medianTat", "median", "median_days")))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- per client closed loop

function PerClient({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  return (
    <Section title="Per client: did we close the loop" tip={metricTooltipFor("perClientClosedLoop")}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Client</th>
              <th className="num">
                <Tooltip title="Shipped" content="Asks from this client that engineering shipped.">
                  <span>Shipped</span>
                </Tooltip>
              </th>
              <th className="num">
                <Tooltip title="Told" content="Of those, how many we actually told the client about.">
                  <span>Told</span>
                </Tooltip>
              </th>
              <th className="num">
                <Tooltip
                  title="Closed-loop rate"
                  content="Share of shipped asks the client has been told about. Higher is better."
                >
                  <span>Closed loop</span>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const shipped = num(pick(r, "shipped", "shipped_count")) ?? 0;
              const told = num(pick(r, "notified", "told", "client_notified", "notified_count")) ?? 0;
              let pct = num(pick(r, "closed_loop_pct", "closedLoopPct", "pct", "rate"));
              if (pct === null && shipped > 0) pct = Math.round((told / shipped) * 100);
              if (pct !== null && pct <= 1) pct = Math.round(pct * 100); // tolerate 0..1 ratios
              return (
                <tr key={i}>
                  <td>{str(pick(r, "client_name", "client", "name")) || "Unknown"}</td>
                  <td className="num">{fmtNum(shipped)}</td>
                  <td className="num">{fmtNum(told)}</td>
                  <td className="num">{pct === null ? "-" : `${fmtNum(pct)}%`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- AI quality

function AiQuality({ data }: { data: Record<string, unknown> }) {
  if (Object.keys(data).length === 0) return null;

  let discard = num(pick(data, "discard_rate", "discardRate", "dropped_rate", "reject_rate"));
  if (discard !== null && discard <= 1) discard = Math.round(discard * 100);
  let edit = num(pick(data, "edit_distance", "editDistance", "avg_edit_distance", "median_edit_distance"));
  let keptRate = num(pick(data, "kept_rate", "keptRate", "accept_rate"));
  if (keptRate !== null && keptRate <= 1) keptRate = Math.round(keptRate * 100);

  const cards: { v: string; k: string; tip: string }[] = [];
  if (discard !== null)
    cards.push({
      v: `${fmtNum(discard)}%`,
      k: "Discard rate",
      tip: "Share of AI-found asks a person rejected as wrong or not useful. Lower is better.",
    });
  if (keptRate !== null)
    cards.push({
      v: `${fmtNum(keptRate)}%`,
      k: "Kept as-is",
      tip: "Share of AI wordings finalized without edits. Higher means the first guess was good.",
    });
  if (edit !== null)
    cards.push({
      v: fmtNum(edit),
      k: "Edit distance",
      tip: "How much people changed the AI's wording on average. Lower means less rewriting.",
    });

  if (cards.length === 0) return null;
  return (
    <Section title="AI quality" tip={metricTooltipFor("aiQuality")}>
      <div className="grid-auto">
        {cards.map((c) => (
          <div className="stat" key={c.k}>
            <div className="v">{c.v}</div>
            <div className="k lbl" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
              {c.k} <Help content={c.tip} title={c.k} />
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- capture volume

function CaptureVolume({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const norm = rows.map((r) => ({
    week: str(pick(r, "week", "label", "period", "date", "bucket")),
    meetings: num(pick(r, "meetings", "meeting_count", "meetings_count")) ?? 0,
    asks: num(pick(r, "asks", "insights", "insight_count", "mentions")),
  }));
  const max = Math.max(...norm.map((r) => r.meetings), 1);
  const askSeries = norm.map((r) => r.asks).filter((v): v is number => v !== null);
  return (
    <Section title="Capture volume by week" tip={metricTooltipFor("captureVolume")}>
      {norm.length > 1 && (
        <div className="row" style={{ gap: 24, alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <Sparkline values={norm.map((r) => r.meetings)} title="Meetings per week, latest at right" />
            <div className="lbl" style={{ margin: "6px 0 0", fontSize: 9.5 }}>
              Meetings / week
            </div>
          </div>
          {askSeries.length === norm.length && askSeries.length > 1 && (
            <div>
              <Sparkline values={askSeries} title="Asks per week, latest at right" />
              <div className="lbl" style={{ margin: "6px 0 0", fontSize: 9.5 }}>
                Asks / week
              </div>
            </div>
          )}
        </div>
      )}
      {norm.map((r, i) => (
        <Bar
          key={i}
          label={r.week || `Week ${i + 1}`}
          value={r.meetings}
          max={max}
          sub={`${fmtNum(r.meetings)} meeting${r.meetings === 1 ? "" : "s"}${
            r.asks !== null ? ` · ${fmtNum(r.asks)} asks` : ""
          }`}
        />
      ))}
    </Section>
  );
}
