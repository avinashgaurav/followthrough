import { demoMode } from "./config.ts";

/**
 * Public demo guard (DEMO_MODE). The demo runs open-access on synthetic data,
 * so every visitor is the guest admin: block anything that changes data or
 * reveals deployment details. Ask stays open (rate-limited per IP in its route).
 */
const WRITE_ALLOW: RegExp[] = [/^\/api\/ask$/];
const READ_BLOCK: RegExp[] = [/^\/api\/users$/, /^\/api\/calendar\//, /^\/api\/watchfolder\//];

export const DEMO_BLOCKED_MESSAGE =
  "This is a read-only demo. Self-host Followthrough to capture your own meetings.";

/** True when DEMO_MODE forbids this request. */
export function demoBlocks(method: string, pathname: string): boolean {
  if (!demoMode()) return false;
  if (method === "GET" || method === "HEAD") return READ_BLOCK.some((p) => p.test(pathname));
  return !WRITE_ALLOW.some((p) => p.test(pathname));
}

/** Client IP behind Cloudflare or a typical proxy; null when unknown. */
export function clientIp(req: Request): string | null {
  return (
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null
  );
}
