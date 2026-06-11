/**
 * Single source of truth for the Insights Engine server location.
 *
 * When the app deploys, change BASE_URL here AND the matching
 * host_permissions entry in manifest.json, then rebuild. Both must
 * point at the same origin or fetches will fail CORS and the session
 * cookie will not be sent.
 */
export const BASE_URL = "http://localhost:4500";

/** Web app page linked from the upload-success view. */
export const MEETINGS_PAGE_URL = `${BASE_URL}/capture`;
