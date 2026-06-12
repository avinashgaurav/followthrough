// Single typed wrapper around the /api contract. Every page goes through this
// module so any backend field drift gets fixed in one file at integration time.
// Response shapes are typed loosely (optional fields) and pages render defensively.

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data?: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "include", ...init });
  } catch {
    throw new ApiError(0, "Couldn't reach the server. Check your connection and retry.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    if (data && typeof data === "object" && "error" in data) {
      msg = String((data as Record<string, unknown>).error);
    }
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postForm<T>(path: string, form: FormData): Promise<T> {
  return request<T>(path, { method: "POST", body: form });
}

// ---------------------------------------------------------------- domain constants

export const STATES = [
  "extracted",
  "triaged",
  "finalized",
  "ticketed",
  "shipped",
  "client_notified",
  "closed",
  "rejected",
  "merged",
] as const;
export type InsightState = (typeof STATES)[number];

export const TRACKS = ["engineering", "marketing", "product_polish", "other"] as const;
export type Track = (typeof TRACKS)[number];

export const ITEM_TYPES = [
  "feature_request",
  "complaint",
  "key_insight",
  "action_item_ours",
  "commitment_theirs",
  "status_update",
] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

export const MEETING_TYPES = ["discovery", "demo", "qbr", "support", "other"] as const;
export const MEETING_SOURCES = ["extension", "meet", "zoom", "fireflies", "manual"] as const;

export const EVIDENCE_KINDS = [
  "release_match",
  "asset_published",
  "ux_verified_in_prod",
  "manual_attestation",
] as const;

/** Hardcoded direct-create allowlist. The XYZ org is write-blocked server-side. */
export const REPO_ALLOWLIST = ["avinashgaurav/followthrough"] as const;

export function insightHandle(id: string): string {
  return `INS-${id.slice(-6).toUpperCase()}`;
}

// ---------------------------------------------------------------- types (loose by design)

export interface User {
  id: string;
  email: string;
  name?: string | null;
  role: "admin" | "member";
  revoked_at?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface Client {
  id: string;
  name: string;
  domain?: string | null;
  crm_id?: string | null;
  created_at?: string;
  meeting_count?: number;
  insight_count?: number;
  open_insight_count?: number;
  [k: string]: unknown;
}

export interface Contact {
  id?: string;
  name?: string | null;
  email?: string | null;
  [k: string]: unknown;
}

export interface Meeting {
  id: string;
  client_id?: string;
  client_name?: string;
  title?: string | null;
  meeting_date?: string;
  seq?: number;
  seq_no?: number;
  meeting_type?: string | null;
  source?: string;
  status?: string;
  created_at?: string;
  [k: string]: unknown;
}

export interface Insight {
  id: string;
  handle?: string;
  meeting_id?: string;
  client_id?: string;
  client_name?: string;
  item_type?: ItemType | string;
  track?: Track | string | null;
  title?: string;
  body_original?: string;
  body_current?: string;
  state?: InsightState | string;
  ai_confidence?: string | null;
  assignee_user_id?: string | null;
  assignee_name?: string | null;
  priority?: number;
  version?: number;
  editing_by?: string | null;
  editing_by_name?: string | null;
  requester_count?: number;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface Mention {
  id?: string;
  quote?: string;
  speaker?: string | null;
  client_id?: string;
  client_name?: string;
  meeting_id?: string;
  meeting_date?: string;
  meeting_seq?: number;
  seq?: number;
  created_at?: string;
  [k: string]: unknown;
}

export interface Ticket {
  id: string;
  insight_id?: string;
  repo?: string | null;
  body_draft?: string;
  draft?: string;
  title?: string;
  state?: string;
  external_url?: string | null;
  issue_url?: string | null;
  raised_at?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface EvidenceRecord {
  id: string;
  insight_id?: string;
  kind?: string;
  url?: string | null;
  status?: string;
  confidence?: number;
  notes?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface EmailDraft {
  id: string;
  insight_id?: string;
  client_id?: string;
  client_name?: string;
  subject?: string;
  body?: string;
  body_draft?: string;
  state?: string;
  status?: string;
  copied_at?: string | null;
  sent_confirmed_at?: string | null;
  created_at?: string;
  [k: string]: unknown;
}

export interface TimelineEvent {
  id?: string | number;
  event_type?: string;
  actor_user_id?: string | null;
  actor_name?: string | null;
  actor_email?: string | null;
  from_state?: string | null;
  to_state?: string | null;
  occurred_at?: string;
  payload?: unknown;
  [k: string]: unknown;
}

export interface InsightDetail {
  insight?: Insight;
  handle?: string;
  mentions?: Mention[];
  requesters?: Array<{ client_id?: string; client_name?: string; name?: string; [k: string]: unknown }>;
  tags?: Array<string | { tag?: string; name?: string; [k: string]: unknown }>;
  tickets?: Ticket[];
  evidence?: EvidenceRecord[];
  email_drafts?: EmailDraft[];
  timeline?: TimelineEvent[];
  [k: string]: unknown;
}

export interface QueueItem {
  id?: string;
  insight_id?: string;
  handle?: string;
  title?: string;
  client_name?: string;
  client_id?: string;
  state?: string;
  track?: string | null;
  created_at?: string;
  updated_at?: string;
  [k: string]: unknown;
}

export interface QueueResponse {
  to_review?: QueueItem[];
  to_finalize?: QueueItem[];
  to_ticket?: QueueItem[];
  to_confirm?: QueueItem[];
  to_email?: QueueItem[];
  org?: Record<string, unknown>;
  org_counts?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface SearchInsightHit {
  id?: string;
  title?: string;
  snippet?: string;
  handle?: string;
  client_name?: string;
  [k: string]: unknown;
}

export interface SearchTranscriptHit {
  meeting_id?: string;
  snippet?: string;
  title?: string;
  client_name?: string;
  [k: string]: unknown;
}

export interface SearchResponse {
  insights: SearchInsightHit[];
  transcripts: SearchTranscriptHit[];
}

export interface CalendarEvent {
  uid?: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: Array<{ name?: string; email?: string }>;
  organizer?: string | { name?: string; email?: string };
  suggested_client_id?: string | null;
  suggested_client_name?: string | null;
  [k: string]: unknown;
}

export interface ExportRecord {
  id: string;
  client_id?: string | null;
  client_name?: string | null;
  status?: string;
  row_count?: number;
  created_at?: string;
  [k: string]: unknown;
}

export interface MatchProposal {
  id: string;
  insight_id?: string;
  insight_title?: string;
  insight_handle?: string;
  entry_id?: string;
  entry_title?: string;
  entry_text?: string;
  release_tag?: string;
  release_published_at?: string;
  confidence?: number;
  verdict?: string;
  rationale?: string;
  evidence_quotes?: string[] | string;
  status?: string;
  [k: string]: unknown;
}

export interface Release {
  id?: string;
  tag?: string;
  tag_name?: string;
  name?: string | null;
  published_at?: string;
  entry_count?: number;
  [k: string]: unknown;
}

export interface SttStatus {
  available?: boolean;
  enabled?: boolean;
  provider?: string;
  [k: string]: unknown;
}

export type MetricsOverview = Record<string, unknown>;

// ---------------------------------------------------------------- helpers

function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // Generic envelope keys plus the entity-named keys the backend actually uses
    // (it wraps lists as {insights:[...]}, {clients:[...]}, etc.).
    for (const key of [
      "items", "results", "rows", "data", "list",
      "insights", "clients", "meetings", "releases", "matches", "events",
      "tickets", "evidence", "completion_evidence", "drafts", "email_drafts",
      "exports", "users", "contacts",
    ]) {
      if (Array.isArray(o[key])) return o[key] as T[];
    }
    // Fallback: if exactly one value is an array, use it.
    const arrays = Object.values(o).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as T[];
  }
  return [];
}

function asMarkdown(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const key of ["markdown", "brief", "text", "content"]) {
      if (typeof o[key] === "string") return o[key] as string;
    }
  }
  return "";
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------- auth

export const api = {
  login: (email: string, code: string) =>
    post<{ user?: User; [k: string]: unknown }>("/api/auth/login", { email, code }),
  logout: () => post<unknown>("/api/auth/logout"),
  me: () => get<{ user: User; require_login?: boolean; is_guest?: boolean }>("/api/me"),

  // ---------------- access mode (admin): open by default, login optional
  getAccess: () => get<{ require_login: boolean; can_require: boolean }>("/api/settings/access"),
  setAccess: (require_login: boolean) =>
    post<{ require_login: boolean }>("/api/settings/access", { require_login }),

  // ---------------- users (admin)
  listUsers: async (): Promise<User[]> => asArray<User>(await get<unknown>("/api/users")),
  createUser: (body: { email: string; name?: string; role?: string }) =>
    post<{ user?: User; loginCode?: string; login_code?: string; [k: string]: unknown }>("/api/users", body),
  rotateCode: (id: string) =>
    post<{ loginCode?: string; login_code?: string; [k: string]: unknown }>(
      `/api/users/${encodeURIComponent(id)}/rotate-code`,
    ),
  revokeUser: (id: string) => post<unknown>(`/api/users/${encodeURIComponent(id)}/revoke`),

  // ---------------- clients
  listClients: async (): Promise<Client[]> => asArray<Client>(await get<unknown>("/api/clients")),
  createClient: (body: { name: string; domain?: string }) =>
    post<{ id?: string; client?: Client; [k: string]: unknown }>("/api/clients", body),
  getClient: (id: string) => get<Record<string, unknown>>(`/api/clients/${encodeURIComponent(id)}`),
  addContact: (clientId: string, body: { name?: string; email?: string }) =>
    post<unknown>(`/api/clients/${encodeURIComponent(clientId)}/contacts`, body),
  getBrief: async (clientId: string): Promise<string> =>
    asMarkdown(await get<unknown>(`/api/clients/${encodeURIComponent(clientId)}/brief`)),

  // ---------------- meetings
  createMeeting: (form: FormData) =>
    postForm<{ id?: string; meeting?: Meeting; duplicate?: boolean; meeting_id?: string; [k: string]: unknown }>(
      "/api/meetings",
      form,
    ),
  listMeetings: async (clientId?: string): Promise<Meeting[]> =>
    asArray<Meeting>(await get<unknown>(`/api/meetings${qs({ client_id: clientId })}`)),
  getMeeting: (id: string) => get<Record<string, unknown>>(`/api/meetings/${encodeURIComponent(id)}`),
  setTranscript: (meetingId: string, text: string) =>
    post<unknown>(`/api/meetings/${encodeURIComponent(meetingId)}/transcript`, { text }),
  transcribe: (meetingId: string) =>
    post<unknown>(`/api/meetings/${encodeURIComponent(meetingId)}/transcribe`),
  sttStatus: () => get<SttStatus>("/api/stt/status"),
  extract: (meetingId: string) =>
    post<Record<string, unknown>>(`/api/meetings/${encodeURIComponent(meetingId)}/extract`),
  /** Latest stored meeting analysis markdown. */
  getAnalysis: async (meetingId: string): Promise<{ markdown: string; created_at?: string }> => {
    const r = await get<Record<string, unknown>>(`/api/meetings/${encodeURIComponent(meetingId)}/analysis`);
    return { markdown: asMarkdown(r), created_at: typeof r?.created_at === "string" ? r.created_at : undefined };
  },
  /** Regenerate meeting analysis. */
  analyzeMeeting: async (meetingId: string): Promise<string> =>
    asMarkdown(await post<unknown>(`/api/meetings/${encodeURIComponent(meetingId)}/analyze`)),
  deleteMeeting: (meetingId: string) =>
    request<unknown>(`/api/meetings/${encodeURIComponent(meetingId)}`, { method: "DELETE" }),

  // ---------------- calendar
  calendarStatus: () => get<{ configured?: boolean; [k: string]: unknown }>("/api/calendar/status"),
  calendarEvents: () =>
    get<{ configured?: boolean; events?: CalendarEvent[]; [k: string]: unknown }>("/api/calendar/events"),
  setCalendar: (ics_url: string) =>
    post<unknown>("/api/admin/calendar", { ics_url }),
  deleteCalendar: () => request<unknown>("/api/admin/calendar", { method: "DELETE" }),

  // ---------------- insights
  createManualInsight: (body: {
    meeting_id: string;
    item_type: string;
    title: string;
    body: string;
    quote?: string;
  }) => post<Record<string, unknown>>("/api/insights/manual", body),
  listInsights: async (filters: {
    state?: string;
    track?: string;
    client_id?: string;
    assignee?: string;
    item_type?: string;
  }): Promise<Insight[]> => asArray<Insight>(await get<unknown>(`/api/insights${qs(filters)}`)),
  // The backend returns the insight FLAT (id/state/title at top level, plus
  // mentions/tickets/completion_evidence/email_drafts/timeline). The UI wants it
  // nested under { insight, evidence, ... }. Normalize here so the contract drift
  // is fixed in one place.
  getInsight: async (id: string): Promise<InsightDetail> => {
    const raw = await get<Record<string, unknown>>(`/api/insights/${encodeURIComponent(id)}`);
    if (raw && raw.insight) return raw as InsightDetail; // already nested
    const {
      handle, mentions, requesters, tags, tickets,
      completion_evidence, evidence, email_drafts, timeline, ...flat
    } = raw ?? {};
    return {
      insight: flat as Insight,
      handle: handle as string | undefined,
      mentions: (mentions as InsightDetail["mentions"]) ?? [],
      requesters: (requesters as InsightDetail["requesters"]) ?? [],
      tags: (tags as InsightDetail["tags"]) ?? [],
      tickets: (tickets as InsightDetail["tickets"]) ?? [],
      evidence: ((completion_evidence ?? evidence) as InsightDetail["evidence"]) ?? [],
      email_drafts: (email_drafts as InsightDetail["email_drafts"]) ?? [],
      timeline: (timeline as InsightDetail["timeline"]) ?? [],
    };
  },
  triage: (id: string, body: { track: string; assignee_user_id?: string; tags?: string[] }) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/triage`, body),
  /** Throws ApiError(409) with data {current_version} on a stale save. */
  saveBody: (id: string, body_current: string, version: number) =>
    put<Record<string, unknown>>(`/api/insights/${encodeURIComponent(id)}/body`, { body_current, version }),
  finalize: (id: string) => post<unknown>(`/api/insights/${encodeURIComponent(id)}/finalize`),
  rejectInsight: (id: string, reason: string) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/reject`, { reason }),
  mergeInsight: (id: string, into_insight_id: string) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/merge`, { into_insight_id }),
  setEditing: (id: string, on: boolean) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/editing`, { on }),
  closeInsight: (id: string, reason?: string) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/close`, reason ? { reason } : {}),
  proposeEvidence: (id: string, body: { kind: string; url?: string; asset_id?: string }) =>
    post<unknown>(`/api/insights/${encodeURIComponent(id)}/evidence`, body),
  generateTicketDraft: (id: string) =>
    post<Record<string, unknown>>(`/api/insights/${encodeURIComponent(id)}/ticket-draft`),
  generateEmailDrafts: (id: string) =>
    post<Record<string, unknown>>(`/api/insights/${encodeURIComponent(id)}/email-drafts`),
  listInsightEvidence: async (id: string): Promise<EvidenceRecord[]> =>
    asArray<EvidenceRecord>(await get<unknown>(`/api/insights/${encodeURIComponent(id)}/evidence`)),
  listInsightEmailDrafts: async (id: string): Promise<EmailDraft[]> =>
    asArray<EmailDraft>(await get<unknown>(`/api/insights/${encodeURIComponent(id)}/email-drafts`)),
  listInsightTickets: async (id: string): Promise<Ticket[]> =>
    asArray<Ticket>(await get<unknown>(`/api/insights/${encodeURIComponent(id)}/tickets`)),

  // ---------------- evidence
  confirmEvidence: (id: string) => post<unknown>(`/api/evidence/${encodeURIComponent(id)}/confirm`),
  rejectEvidence: (id: string, reason: string) =>
    post<unknown>(`/api/evidence/${encodeURIComponent(id)}/reject`, { reason }),

  // ---------------- tickets
  markRaised: (ticketId: string, external_url: string) =>
    post<unknown>(`/api/tickets/${encodeURIComponent(ticketId)}/mark-raised`, { external_url }),
  createDirect: (ticketId: string, repo: string) =>
    post<Record<string, unknown>>(`/api/tickets/${encodeURIComponent(ticketId)}/create-direct`, { repo }),

  // ---------------- emails
  emailCopied: (draftId: string) => post<unknown>(`/api/emails/${encodeURIComponent(draftId)}/copied`),
  emailSentConfirm: (draftId: string, final_text?: string) =>
    post<unknown>(
      `/api/emails/${encodeURIComponent(draftId)}/sent-confirm`,
      final_text ? { final_text } : {},
    ),

  // ---------------- queue / search / metrics
  queue: () => get<QueueResponse>("/api/queue"),
  search: async (
    q: string,
    filters: { client_id?: string; track?: string; state?: string } = {},
  ): Promise<SearchResponse> => {
    const r = await get<Record<string, unknown>>(`/api/search${qs({ q, ...filters })}`);
    return {
      insights: asArray<SearchInsightHit>(r?.insights),
      transcripts: asArray<SearchTranscriptHit>(r?.transcripts),
    };
  },
  metricsOverview: () => get<MetricsOverview>("/api/metrics/overview"),

  // ---------------- releases / matches
  listReleases: async (): Promise<Release[]> => asArray<Release>(await get<unknown>("/api/releases")),
  /** Raw releases envelope; includes repo + whether a GitHub read token is configured. */
  releasesStatus: () =>
    get<{ releases?: Release[]; repo?: string; github_token_configured?: boolean }>("/api/releases"),
  pollReleases: () => post<Record<string, unknown>>("/api/releases/poll"),
  listMatches: async (status = "proposed"): Promise<MatchProposal[]> =>
    asArray<MatchProposal>(await get<unknown>(`/api/matches${qs({ status })}`)),
  confirmMatch: (id: string) => post<unknown>(`/api/matches/${encodeURIComponent(id)}/confirm`),
  rejectMatch: (id: string) => post<unknown>(`/api/matches/${encodeURIComponent(id)}/reject`),

  // ---------------- exports / digest / admin extras
  exportCsv: (client_id?: string) =>
    post<{ id?: string; export_id?: string; [k: string]: unknown }>(
      "/api/exports/csv",
      client_id ? { client_id } : {},
    ),
  listExports: async (): Promise<ExportRecord[]> => asArray<ExportRecord>(await get<unknown>("/api/exports")),
  exportDownloadUrl: (id: string) => `/api/exports/${encodeURIComponent(id)}/download`,
  digestPreview: async (): Promise<string> => asMarkdown(await get<unknown>("/api/digest/preview")),

  // ---------------- watchfolder (read-only status)
  watchfolderStatus: () => get<Record<string, unknown>>("/api/watchfolder/status"),

  /** Endpoint guessed; not in the written contract. Page handles 404 gracefully. */
  rebuildSearch: () => post<unknown>("/api/search/rebuild"),
};

export { asArray, asMarkdown };
