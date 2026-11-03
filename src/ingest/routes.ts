import { route, json } from "../router.ts";
import { hostedMode } from "../config.ts";
import { controlRateLimited, currentWorkspaceId, getWorkspace, refundMeeting, reserveMeeting } from "../hosted/tenancy.ts";
import { getDb } from "../db.ts";
import type { AuthedUser } from "../auth.ts";
import {
  handleAddContact,
  handleAddTranscript,
  handleCreateClient,
  handleCreateMeeting,
  handleDownloadMedia,
  handleGetClient,
  handleGetMeeting,
  handleListClients,
  handleListMeetings,
  handleStartUpload,
} from "./service.ts";

// Auth tier "user" guarantees a non-null user; the router rejects with 401 first.

route("POST", "/api/clients", "user", (req, user) =>
  handleCreateClient(getDb(), user as AuthedUser, req),
);

route("GET", "/api/clients", "user", () => handleListClients(getDb()));

route("GET", "/api/clients/:id", "user", (_req, _user, params) =>
  handleGetClient(getDb(), params.id ?? ""),
);

route("POST", "/api/clients/:id/contacts", "user", (req, user, params) =>
  handleAddContact(getDb(), user as AuthedUser, params.id ?? "", req),
);

// Hosted mode: each new meeting takes one of the workspace's free meetings
// (it is what gets transcribed and extracted on this deployment's AI key).
// Anything but a fresh 201 gives it back.
route("POST", "/api/meetings", "user", async (req, user) => {
  const ws = hostedMode() ? currentWorkspaceId() : null;
  if (ws && !(await reserveMeeting(getDb(), ws))) {
    return json(
      { error: "You've used all your free meetings. Self-host Followthrough to keep going with your own AI key.", kind: "quota" },
      402,
    );
  }
  let res: Response | null = null;
  try {
    res = await handleCreateMeeting(getDb(), user as AuthedUser, req);
    return res;
  } finally {
    if (ws && res?.status !== 201) await refundMeeting(getDb(), ws);
  }
});

// Hosted: no signed upload URLs once the free meetings are gone, and at most
// 30 a day per workspace, so storage cannot be filled without meetings.
route("POST", "/api/uploads", "user", async (req) => {
  const ws = hostedMode() ? currentWorkspaceId() : null;
  if (ws) {
    const w = await getWorkspace(getDb(), ws);
    if (!w || w.meetings_used >= w.meetings_quota) {
      return json({ error: "You've used all your free meetings.", kind: "quota" }, 402);
    }
    if (await controlRateLimited(getDb(), `uploads:${ws}`, 30, 86_400_000)) {
      return json({ error: "Too many uploads today. Try again tomorrow." }, 429);
    }
  }
  return handleStartUpload(req);
});

route("GET", "/api/meetings", "user", (req) => handleListMeetings(getDb(), req));

route("GET", "/api/meetings/:id", "user", (_req, _user, params) =>
  handleGetMeeting(getDb(), params.id ?? ""),
);

route("POST", "/api/meetings/:id/transcript", "user", (req, user, params) =>
  handleAddTranscript(getDb(), user as AuthedUser, params.id ?? "", req),
);

route("GET", "/api/media/:id/download", "user", (_req, user, params) =>
  handleDownloadMedia(getDb(), user as AuthedUser, params.id ?? ""),
);
