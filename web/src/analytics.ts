import type { BeforeSend } from "@vercel/analytics/react";

// Page views only ever carry a scrubbed path. The auth callback holds a
// one-time token, so it is never sent; record ids in paths become :id.
const DETAIL_ROUTE = /^\/(meetings|insights|clients)\/[^/]+$/;
const ID_LIKE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{16,}|\d{4,})$/i;

export const scrubPageView: BeforeSend = (event) => {
  const url = new URL(event.url);
  if (url.pathname.startsWith("/auth/")) return null;
  let path = url.pathname;
  if (DETAIL_ROUTE.test(path)) {
    path = path.replace(/[^/]+$/, ":id");
  } else {
    const segments = path.split("/");
    const last = segments.length - 1;
    if (ID_LIKE.test(decodeURIComponent(segments[last] ?? ""))) segments[last] = ":id";
    path = segments.join("/");
  }
  return { ...event, url: `${url.origin}${path}` };
};
