// Records the static read-only demo's fixtures (web/src/demo/fixtures.json)
// from a running DEMO_MODE server seeded with the fictional demo meetings.
// Every response is stored exactly as the server sent it, errors included, so
// the static build behaves like the hosted DEMO_MODE instance minus live calls.
//
//   DEMO_MODE=true LLM_PROVIDER=claude-cli DATA_DIR=/tmp/ftdemo bun run seed:demo
//   DEMO_MODE=true LLM_PROVIDER=claude-cli DATA_DIR=/tmp/ftdemo bun run start
//   bun run scripts/record-demo-fixtures.ts [http://localhost:4500]
//
// Ask answers are recorded for ASK_QUESTIONS only (one model call each).

const base = (process.argv[2] ?? "http://localhost:4500").replace(/\/$/, "");
const out = new URL("../web/src/demo/fixtures.json", import.meta.url);

const ASK_QUESTIONS = [
  "What did we promise Acme?",
  "What is blocking the Globex rollout?",
  "What did Initech complain about?",
];

const responses: Record<string, { status: number; body: unknown }> = {};

async function rec(path: string): Promise<unknown> {
  if (path in responses) return responses[path]!.body;
  const res = await fetch(base + path);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  responses[path] = { status: res.status, body };
  console.log(res.status, path);
  return body;
}

const list = (body: unknown, key: string): Array<Record<string, unknown>> => {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : body;
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
};
const enc = encodeURIComponent;

for (const p of [
  "/api/me",
  "/api/auth/session",
  "/api/auth/config",
  "/api/settings/access",
  "/api/users",
  "/api/queue",
  "/api/metrics/overview",
  "/api/releases",
  "/api/matches?status=proposed",
  "/api/matches?status=confirmed",
  "/api/exports",
  "/api/digest/preview",
  "/api/stt/status",
  "/api/calendar/status",
  "/api/calendar/events",
  "/api/watchfolder/status",
  "/api/insights",
]) {
  await rec(p);
}

for (const c of list(await rec("/api/clients"), "clients")) {
  const id = enc(String(c.id));
  await rec(`/api/clients/${id}`);
  await rec(`/api/clients/${id}/brief`);
  await rec(`/api/meetings?client_id=${id}`);
  await rec(`/api/insights?client_id=${id}`);
}
for (const m of list(await rec("/api/meetings"), "meetings")) {
  const id = enc(String(m.id));
  await rec(`/api/meetings/${id}`);
  await rec(`/api/meetings/${id}/analysis`);
}
for (const i of list(responses["/api/insights"]!.body, "insights")) {
  const id = enc(String(i.id));
  await rec(`/api/insights/${id}`);
  await rec(`/api/insights/${id}/evidence`);
  await rec(`/api/insights/${id}/email-drafts`);
  await rec(`/api/insights/${id}/tickets`);
}

const ask: Record<string, unknown> = {};
for (const question of ASK_QUESTIONS) {
  const res = await fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`Ask failed (${res.status}): ${await res.text()}`);
  const { usage: _usage, ...answer } = (await res.json()) as Record<string, unknown>;
  ask[question] = answer;
  console.log("ask", question);
}

// The read-only demo has no /share route, so a recorded share token would
// render a client share link that 404s. Null every share_token before writing.
function stripShareTokens(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripShareTokens);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = k === "share_token" ? null : stripShareTokens(x);
    return o;
  }
  return v;
}

// Model prose sometimes uses a dash as a sentence break; the project style bans
// it, so it becomes a comma here. The demo transcripts contain none, so quoted
// transcript text is untouched.
const json = JSON.stringify(
  stripShareTokens({ generated_at: new Date().toISOString(), responses, ask }),
  null,
  2,
)
  .replace(/\s*\u2014\s*/g, ", ")
  .replace(/ \u2013 /g, ", ");
await Bun.write(out, json + "\n");
console.log(`Wrote ${Object.keys(responses).length} responses and ${Object.keys(ask).length} Ask answers to ${out.pathname}`);
