import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import {
  CalendarConfigError,
  CalendarFetchError,
  clearFeedUrl,
  fetchEvents,
  getFeedUrl,
  setFeedUrl,
} from "./service.ts";

route("GET", "/api/calendar/status", "user", () =>
  json({ configured: getFeedUrl(getDb()) !== null }),
);

route("GET", "/api/calendar/events", "user", async () => {
  try {
    const result = await fetchEvents(getDb());
    return json(result); // {configured, events}; unconfigured = {configured:false, events:[]}
  } catch (err) {
    if (err instanceof CalendarFetchError) {
      return json(
        { error: `Calendar feed unavailable. ${err.message} Check the ICS URL in admin settings or try again.` },
        503,
      );
    }
    throw err;
  }
});

const ConfigBody = z.object({ ics_url: z.string().min(1) });

route("POST", "/api/admin/calendar", "admin", async (req, user) => {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const parsed = ConfigBody.safeParse(raw);
  if (!parsed.success) return json({ error: "invalid body", issues: parsed.error.issues }, 400);

  try {
    setFeedUrl(getDb(), parsed.data.ics_url, user!.id);
  } catch (err) {
    if (err instanceof CalendarConfigError) return json({ error: err.message }, 400);
    throw err;
  }
  return json({ configured: true });
});

route("DELETE", "/api/admin/calendar", "admin", (_req, user) => {
  clearFeedUrl(getDb(), user!.id);
  return json({ configured: false });
});
