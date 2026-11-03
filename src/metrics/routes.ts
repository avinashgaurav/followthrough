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

route("GET", "/api/metrics/overview", "admin", async () => {
  const db = getDb();
  return json({
    stage_tats: await stageTats(db),
    funnel: await funnel(db),
    wip_aging: await wipAndAging(db),
    stuck_items: await stuckItems(db),
    per_person: await perPerson(db),
    per_client_closed_loop: await perClientClosedLoop(db),
    theme_demand: await themeDemand(db),
    ai_quality: await aiQuality(db),
    capture_volume: await captureVolume(db),
  });
});

route("GET", "/api/clients/:id/brief", "user", async (_req, _user, params) => {
  const markdown = await clientBrief(getDb(), params.id!);
  if (markdown === null) return json({ error: "client not found" }, 404);
  return json({ markdown });
});
