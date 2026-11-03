import { route, json } from "../router.ts";

// The watch folder (auto-ingest from a local inbox directory) was removed with
// the move to Vercel: serverless functions have no persistent local folder.
// The status route stays so the Settings page keeps reporting it as off.
route("GET", "/api/watchfolder/status", "user", () =>
  json({ enabled: false, reason: "Not available on the hosted deployment. Upload transcripts on Capture." }),
);
