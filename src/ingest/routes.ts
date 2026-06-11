import { route } from "../router.ts";
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

route("POST", "/api/meetings", "user", (req, user) =>
  handleCreateMeeting(getDb(), user as AuthedUser, req),
);

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
