import type { Database } from "bun:sqlite";
import { env } from "./config.ts";

/**
 * Chat nudges (SPEC section 12 nudges, delivered): short messages pushed to the
 * same Slack/Google Chat incoming webhook the weekly digest uses
 * (DIGEST_WEBHOOK_URL). The tool must reach people who have not opened it —
 * a queue that can only nag visitors cannot recover lapsed users.
 *
 * Fire-and-forget by design: a nudge failure must never fail the action that
 * triggered it.
 */

export async function sendChat(
  text: string,
  fetchImpl: typeof fetch = fetch,
  webhookUrl: string | undefined = env.DIGEST_WEBHOOK_URL,
): Promise<boolean> {
  if (!webhookUrl) return false;
  try {
    const res = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch (err) {
    console.warn("chat nudge failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/** "12 insights found from the Acme General call — review them." */
export function extractionNudgeText(opts: {
  created: number;
  clientName: string | null;
  meetingTitle: string | null;
  appUrl?: string;
}): string {
  const what = `${opts.created} ${opts.created === 1 ? "insight" : "insights"}`;
  const from = opts.clientName ? ` from the ${opts.clientName} call` : "";
  const title = opts.meetingTitle ? ` ("${opts.meetingTitle}")` : "";
  const link = opts.appUrl ? ` ${opts.appUrl}/review` : "";
  return `${what} found${from}${title} — review them.${link}`;
}

/** Daily "what's waiting" summary. Returns null when nothing is waiting. */
export function dailyNudgeText(db: Database, appUrl?: string): string | null {
  const counts = db
    .query("SELECT state, COUNT(*) AS n FROM insights WHERE state IN ('extracted','triaged','finalized','shipped') GROUP BY state")
    .all() as Array<{ state: string; n: number }>;
  const by = Object.fromEntries(counts.map((c) => [c.state, c.n]));
  const parts: string[] = [];
  if (by.extracted) parts.push(`${by.extracted} new from AI`);
  if (by.triaged) parts.push(`${by.triaged} need final wording`);
  if (by.finalized) parts.push(`${by.finalized} ready for a ticket`);
  if (by.shipped) parts.push(`${by.shipped} clients to tell`);
  if (parts.length === 0) return null;
  const link = appUrl ? ` ${appUrl}` : "";
  return `Waiting on the team: ${parts.join(", ")}.${link}`;
}

let dailyTimer: ReturnType<typeof setInterval> | null = null;

/** Once a day, post the waiting summary. No-op without a webhook. */
export function startDailyNudge(getDbFn: () => Database): void {
  if (!env.DIGEST_WEBHOOK_URL || dailyTimer) return;
  dailyTimer = setInterval(() => {
    try {
      const text = dailyNudgeText(getDbFn());
      if (text) void sendChat(text);
    } catch (err) {
      console.warn("daily nudge failed:", err);
    }
  }, 24 * 60 * 60 * 1000);
}
