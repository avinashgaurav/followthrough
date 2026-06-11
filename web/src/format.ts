// Formatting + plain-language label helpers. All times arrive from the API as ISO strings.
// Copy here is intentionally jargon-free for a non-technical founder. No em-dashes.

export function formatDate(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return (
    d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) +
    " " +
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  );
}

/** Compact age from a count of days, e.g. 0d, 3d, 2w, 4mo. */
export function relativeAge(days: number | undefined | null): string {
  if (days === undefined || days === null || Number.isNaN(days)) return "";
  const d = Math.max(0, Math.floor(days));
  if (d < 1) return "today";
  if (d < 14) return `${d}d`;
  if (d < 60) return `${Math.round(d / 7)}w`;
  return `${Math.round(d / 30)}mo`;
}

/** Compact age from an ISO timestamp. */
export function ageOf(iso: string | undefined | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const days = Math.floor((Date.now() - t) / 86_400_000);
  return relativeAge(days);
}

export function fmtNum(v: unknown): string {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString("en-US");
    return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(v ?? "");
}

/** snake_case and camelCase -> spaced words, generic fallback. */
export function titleCase(s: string | undefined | null): string {
  if (!s) return "";
  return s.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
}

// ---------------------------------------------------------------- track + item-type labels

const TRACK_LABELS: Record<string, string> = {
  engineering: "Engineering",
  product_polish: "Product polish",
  "product polish": "Product polish",
  marketing: "Marketing",
  other: "Other",
};

export function trackLabel(track: string | undefined | null): string {
  if (!track) return "Not routed yet";
  return TRACK_LABELS[track] ?? titleCase(track);
}

const ITEM_TYPE_LABELS: Record<string, string> = {
  feature_request: "Feature request",
  complaint: "Complaint",
  key_insight: "Insight",
  action_item_ours: "Our action item",
  commitment_theirs: "Their commitment",
  status_update: "Status update",
};

export function itemTypeLabel(t: string | undefined | null): string {
  if (!t) return "";
  return ITEM_TYPE_LABELS[t] ?? titleCase(t);
}

// ---------------------------------------------------------------- state labels + tooltips

const STATE_LABELS: Record<string, string> = {
  extracted: "Extracted",
  triaged: "Triaged",
  finalized: "Finalized",
  ticketed: "Ticketed",
  shipped: "Shipped",
  client_notified: "Client told",
  closed: "Closed",
  rejected: "Rejected",
  merged: "Merged",
};

export function stateLabel(state: string | undefined | null): string {
  if (!state) return "";
  return STATE_LABELS[state] ?? titleCase(state);
}

/** Plain-words explanation of each state, shown as a tooltip on every state pill. */
export const stateTooltip: Record<string, string> = {
  extracted: "The AI pulled this out of a meeting. Nobody has checked it yet.",
  triaged: "Someone decided what it is and who owns it. The wording is not locked yet.",
  finalized: "The wording is locked. It can now become a ticket or be marked shipped.",
  ticketed: "A ticket has been drafted or raised for engineering to build it.",
  shipped: "Engineering shipped it. We still need to confirm it and tell the client.",
  client_notified: "We told the client it shipped. The loop is closed.",
  closed: "Done and put to rest. No further action needed.",
  rejected: "Wrong or not useful. It stays on record but goes no further.",
  merged: "Folded into another insight that says the same thing.",
};

export function stateTooltipFor(state: string | undefined | null): string {
  if (!state) return "";
  return stateTooltip[state] ?? "";
}

// ---------------------------------------------------------------- Numbers metric definitions

/** Plain-words definition for every metric shown on the Numbers page. */
export const metricTooltip: Record<string, string> = {
  extracted_to_finalized: "Average time from the AI finding an ask to someone locking its wording.",
  finalized_to_ticketed: "Time from locked wording to a ticket being raised for engineering.",
  ticketed_to_shipped: "Time engineering took to build it after the ticket was raised.",
  finalized_to_shipped: "Time from locked wording all the way to shipped.",
  shipped_to_notified: "Time from shipping to telling the client it is live.",
  end_to_end: "Total turnaround time: from meeting to the client being told.",
  funnel: "How many asks reach each stage. Drop-off shows where things stall.",
  wipAndAging: "How much work is in flight and how old the oldest items are.",
  oldestOpenItem: "How long the longest-waiting open item has been sitting. If this grows, something is stuck.",
  stuckItems: "Items that have not moved for a while and need a nudge.",
  perPerson: "What each teammate owns and how fast they move it.",
  perClientClosedLoop: "Per client: how many asks we shipped and actually told them about.",
  themeDemand: "Which topics clients ask for most often across all meetings.",
  aiQuality: "How often the AI's first guess was kept versus corrected.",
  captureVolume: "How many meetings and asks we took in over time.",
  avg: "Average across all items measured.",
  median: "The middle value. Half were faster, half slower.",
  p90: "90 percent finished within this time. Catches the slow tail.",
  n: "How many items this number is based on.",
  turnaround: "How long an ask takes to move between two stages.",
};

export function metricTooltipFor(key: string | undefined | null): string {
  if (!key) return "";
  return metricTooltip[key] ?? "";
}
