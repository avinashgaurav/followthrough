import { handleApi } from "../src/app.ts";

/**
 * Vercel function for every /api/* and /share/* request (Bun runtime, see
 * vercel.json). The rewrites send each request here with its original path in
 * ?__path=, which is restored before routing so the router sees the same URL
 * the browser asked for.
 */
export default {
  async fetch(req: Request): Promise<Response> {
    return handleApi(restorePath(req));
  },
};

export function restorePath(req: Request): Request {
  const url = new URL(req.url);
  // Vercel puts the rewrite's own __path first, ahead of any the client sent
  // (checked on a deployment), so the first value is the real path. Every
  // __path is then removed, so a client-supplied one never reaches the app.
  const original = url.searchParams.get("__path");
  if (!original) return req;
  url.searchParams.delete("__path");
  url.pathname = original.startsWith("/") ? original : `/${original}`;
  return new Request(url, req);
}
