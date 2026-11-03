import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { buildDigest } from "./digest.ts";

route("GET", "/api/digest/preview", "admin", async () => json({ markdown: await buildDigest(getDb()) }));
