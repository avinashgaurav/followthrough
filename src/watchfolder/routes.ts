import { route, json } from "../router.ts";
import { getDb } from "../db.ts";
import { watchFolderStatus } from "./service.ts";

// Watch-folder visibility (SPEC.md section 2.1): what is waiting in the inbox
// and how much was auto-ingested today.

route("GET", "/api/watchfolder/status", "user", () => json(watchFolderStatus(getDb())));
