/**
 * Server-rendered HTML for the public "You asked, we shipped" page.
 * Transcript Spine system (see DESIGN.md), self-contained (no SPA, no JS),
 * everything escaped. Shows each shipped request with its ask→ship turnaround,
 * a headline median, and what's still in progress. Print styles render a clean
 * light PDF.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanTitle(s: string): string {
  return s.replace(/^\s*SUBTEXT:\s*/i, "");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Whole days between two ISO timestamps, or null if either is missing/invalid. */
function daysBetween(askedIso: string | null, shippedIso: string | null): number | null {
  if (!askedIso || !shippedIso) return null;
  const a = new Date(askedIso).getTime();
  const s = new Date(shippedIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(s) || s < a) return null;
  return Math.max(0, Math.round((s - a) / 86_400_000));
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export interface ShippedItem {
  title: string;
  state: string;
  item_type: string;
  asked_at: string | null;
  shipped_at: string | null;
}

export function formatHtml(clientName: string, shipped: ShippedItem[], inFlightTitles: string[]): string {
  const turnarounds = shipped
    .map((s) => daysBetween(s.asked_at, s.shipped_at))
    .filter((n): n is number => n !== null);
  const med = median(turnarounds);

  const headline =
    shipped.length === 0
      ? "The first items from our conversations are in flight — this page updates as they ship."
      : `We shipped ${shipped.length} ${shipped.length === 1 ? "request" : "requests"} you raised${
          med !== null ? `, typically <strong>${med} ${med === 1 ? "day" : "days"}</strong> from when you asked to when it shipped` : ""
        }.`;

  const rows = shipped
    .map((s) => {
      const days = daysBetween(s.asked_at, s.shipped_at);
      const askLine = s.asked_at ? `Asked ${esc(fmtDate(s.asked_at))}` : "";
      const shipLine = s.shipped_at ? `shipped ${esc(fmtDate(s.shipped_at))}` : "shipped";
      const daysLine = days !== null ? ` &middot; <span class="days">${days} ${days === 1 ? "day" : "days"}</span>` : "";
      const meta = askLine ? `${askLine} &rarr; ${shipLine}${daysLine}` : `${shipLine}${daysLine}`;
      return `
      <li>
        <span class="check">&#10003;</span>
        <span class="t">${esc(cleanTitle(s.title))}</span>
        <span class="meta">${meta}</span>
      </li>`;
    })
    .join("\n");

  const inFlightRows = inFlightTitles
    .map((t) => `<li><span class="dot"></span><span class="t">${esc(cleanTitle(t))}</span></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<meta name="robots" content="noindex" />
<title>What you asked for &middot; ${esc(clientName)}</title>
<style>
  :root {
    --canvas:#0a0b0d; --p1:#101214; --line:#24272c; --ink:#f6f7f8; --muted:#8a8f98;
    --signal:#f4a521; --signal-hi:#ffc24a; --r:2px;
    --serif:"Newsreader",Georgia,"Times New Roman",serif;
    --font:"Inter",-apple-system,system-ui,sans-serif;
  }
  * { box-sizing:border-box; margin:0; }
  body { background:var(--canvas); color:var(--ink); font:15px/1.6 var(--font); padding:56px 20px; }
  main { max-width:680px; margin:0 auto; }
  .brand { display:flex; align-items:center; gap:10px; color:var(--muted); font-size:13px; letter-spacing:0.01em; }
  .mark { width:20px; height:20px; flex:0 0 auto; }
  .brand strong { color:var(--ink); font-weight:600; }
  h1 { font-family:var(--serif); font-size:30px; font-weight:500; letter-spacing:-0.01em; margin:22px 0 10px; }
  .sub { color:var(--muted); margin-bottom:36px; font-size:16px; }
  .sub strong { color:var(--ink); font-weight:600; }
  .lbl { font-size:12px; font-weight:600; letter-spacing:.04em; color:var(--muted); margin:28px 0 12px; }
  ul { list-style:none; padding:0; border:1px solid var(--line); border-radius:var(--r); background:var(--p1); }
  li { display:flex; gap:12px; align-items:baseline; padding:14px 16px; border-bottom:1px solid var(--line); }
  li:last-child { border-bottom:none; }
  .check { color:var(--signal); font-weight:700; flex:0 0 auto; }
  .dot { width:7px; height:7px; border:1.5px solid var(--muted); border-radius:50%; flex:0 0 auto; align-self:center; }
  .t { flex:1; }
  .meta { color:var(--muted); font-size:12px; white-space:nowrap; }
  .meta .days { color:var(--ink); font-weight:600; }
  .empty { border:1px solid var(--line); border-radius:var(--r); background:var(--p1); padding:24px 16px; color:var(--muted); }
  footer { margin-top:48px; color:var(--muted); font-size:12px; border-top:1px solid var(--line); padding-top:16px; }
  @media print {
    body { background:#fff; color:#1a1916; padding:24px 0; }
    .sub, .lbl, .meta, footer, .brand { color:#6c685f; }
    .sub strong, .meta .days, .brand strong { color:#1a1916; }
    .check { color:#b5791a; }
    ul, .empty { border-color:#e6dfd3; background:#fff; }
    li { border-bottom-color:#efe9dd; }
    footer { border-top-color:#e6dfd3; }
  }
</style>
</head>
<body>
<main>
  <div class="brand">
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="2" fill="#0a0b0d"/><rect x="15" y="5" width="2" height="22" fill="#272A2F"/><circle cx="16" cy="16" r="4" fill="#f4a521"/></svg>
    <strong>Followthrough</strong>
  </div>
  <h1>What you asked for, ${esc(clientName)}</h1>
  <p class="sub">${headline}</p>

  <div class="lbl">Shipped</div>
  ${shipped.length > 0 ? `<ul>${rows}</ul>` : `<div class="empty">The first items from our conversations are in flight — this page updates as they ship.</div>`}

  ${
    inFlightTitles.length > 0
      ? `<div class="lbl">In progress</div><ul>${inFlightRows}</ul>`
      : ""
  }

  <footer>Prepared with Followthrough. Questions? Just reply to your account contact.</footer>
</main>
</body>
</html>`;
}
