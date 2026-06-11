import { route } from "../router.ts";
import { getDb } from "../db.ts";
import type { AuthedUser } from "../auth.ts";
import { handlePurgeMeeting } from "./service.ts";

// Retention (SPEC.md section 10): admin-only purge of a meeting's raw material.
// Auth tier "admin" guarantees a non-null admin user; the router rejects first.

route("DELETE", "/api/meetings/:id", "admin", (req, user, params) =>
  handlePurgeMeeting(getDb(), user as AuthedUser, params.id ?? "", req),
);
