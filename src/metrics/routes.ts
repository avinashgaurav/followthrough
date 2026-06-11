import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import {
  aiQuality,
  captureVolume,
  clientBrief,
  funnel,
  perClientClosedLoop,
  perPerson,
  stageTats,
  stuckItems,
  themeDemand,
  wipAndAging,
} from "./queries.ts";

route("GET", "/api/metrics/overview", "admin", () => {
  const db = getDb();
  return json({
    stage_tats: stageTats(db),
    funnel: funnel(db),
    wip_aging: wipAndAging(db),
    stuck_items: stuckItems(db),
    per_person: perPerson(db),
    per_client_closed_loop: perClientClosedLoop(db),
    theme_demand: themeDemand(db),
    ai_quality: aiQuality(db),
    capture_volume: captureVolume(db),
  });
});

route("GET", "/api/clients/:id/brief", "user", (_req, _user, params) => {
  const markdown = clientBrief(getDb(), params.id!);
  if (markdown === null) return json({ error: "client not found" }, 404);
  return json({ markdown });
});
