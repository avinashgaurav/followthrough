// Static, read-only demo backend. Only bundled by `bun run build:demo`
// (vite --mode demo; see vite.config.ts and README.md in this folder).
//
// Every GET is answered from fixtures.json: real API responses recorded from a
// DEMO_MODE server seeded with the fictional meetings in demo/. Nothing calls a
// server or a model. Every write, upload or "process a meeting" action is
// refused with STATIC_DEMO_NOTICE, which the pages already show as a toast or
// an alert because they surface ApiError messages.

import { ApiError } from "../api";
import recorded from "./fixtures.json";

interface Recorded {
  status: number;
  body: unknown;
}

const fixtures = recorded as {
  generated_at: string;
  responses: Record<string, Recorded>;
  ask: Record<string, unknown>;
};

export const STATIC_DEMO_NOTICE =
  "Read-only demo: nothing can be changed or processed here. Run Followthrough yourself to process your own calls.";

function respond<T>(r: Recorded): T {
  if (r.status >= 400) {
    const b = r.body as Record<string, unknown> | null;
    const msg = b && typeof b === "object" && "error" in b ? String(b.error) : `Request failed (${r.status})`;
    throw new ApiError(r.status, msg, r.body);
  }
  // Hand out a copy so pages that mutate responses never touch the fixture.
  return structuredClone(r.body) as T;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** GET /api/insights with a filter combination that was not recorded: filter the full list. */
function filteredInsights(params: URLSearchParams): unknown | undefined {
  const all = fixtures.responses["/api/insights"];
  if (!all || all.status >= 400) return undefined;
  const body = structuredClone(all.body) as { insights?: Array<Record<string, unknown>> };
  const fields: Array<[string, string]> = [
    ["state", "state"],
    ["track", "track"],
    ["client_id", "client_id"],
    ["assignee", "assignee_user_id"],
    ["item_type", "item_type"],
  ];
  const rows = (body.insights ?? []).filter((row) =>
    fields.every(([param, field]) => {
      const want = params.get(param);
      return !want || row[field] === want;
    }),
  );
  return { ...body, insights: rows };
}

/** GET /api/search: plain substring match over the recorded insights and transcripts. */
function search(params: URLSearchParams): unknown {
  const q = norm(params.get("q") ?? "");
  const insights: unknown[] = [];
  const transcripts: unknown[] = [];
  if (q.length < 2) return { insights, transcripts };
  const list = filteredInsights(params) as { insights?: Array<Record<string, unknown>> } | undefined;
  for (const row of list?.insights ?? []) {
    const title = String(row.title ?? "");
    if (norm(title).includes(q)) {
      insights.push({ id: row.id, title, snippet: title, handle: row.handle, client_name: row.client_name });
    }
  }
  for (const [key, r] of Object.entries(fixtures.responses)) {
    if (!/^\/api\/meetings\/[^/?]+$/.test(key) || r.status >= 400) continue;
    const m = r.body as Record<string, unknown>;
    const meeting = (m.meeting ?? m) as Record<string, unknown>;
    const text = String(m.transcript_text ?? meeting.transcript_text ?? "");
    const at = norm(text).indexOf(q);
    if (at < 0) continue;
    const flat = text.replace(/\s+/g, " ");
    transcripts.push({
      meeting_id: meeting.id,
      title: meeting.title,
      client_name: meeting.client_name,
      snippet: flat.slice(Math.max(0, at - 60), at + q.length + 80),
    });
  }
  return { insights, transcripts };
}

export async function demoRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const url = new URL(path, "http://demo.invalid");

  if (method === "POST" && url.pathname === "/api/ask") {
    const q = typeof init.body === "string" ? norm(String(JSON.parse(init.body).question ?? "")) : "";
    const answer = Object.entries(fixtures.ask).find(([k]) => norm(k) === q)?.[1];
    if (answer) return structuredClone(answer) as T;
    const examples = Object.keys(fixtures.ask).map((k) => `"${k}"`).join(" or ");
    throw new ApiError(
      403,
      `Read-only demo: Ask makes a live model call, so only recorded answers are available here. Try ${examples}, or run Followthrough yourself to ask anything.`,
    );
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new ApiError(403, STATIC_DEMO_NOTICE, { error: STATIC_DEMO_NOTICE, demo: true });
  }

  const hit = fixtures.responses[url.pathname + url.search];
  if (hit) return respond<T>(hit);
  if (url.pathname === "/api/insights") {
    const body = filteredInsights(url.searchParams);
    if (body) return body as T;
  }
  if (url.pathname === "/api/search") return search(url.searchParams) as T;
  throw new ApiError(404, "Not part of the read-only demo. Run Followthrough yourself to see this view on your own calls.");
}
