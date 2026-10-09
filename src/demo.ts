import { demoMode, env, trustCfConnectingIp } from "./config.ts";

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

/**
 * Client IP as seen by the nearest TRUSTED proxy; null when unknown.
 * Proxies append to X-Forwarded-For, so only the rightmost TRUSTED_PROXY_HOPS
 * entries are trustworthy; anything to their left is client-supplied.
 * cf-connecting-ip is honored only when TRUST_CF_CONNECTING_IP is on.
 */
export function clientIp(req: Request): string | null {
  if (trustCfConnectingIp()) {
    const cf = req.headers.get("cf-connecting-ip")?.trim();
    if (cf) return cf;
  }
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops === 0) return null;
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return chain.length >= hops ? chain[chain.length - hops]! : null;
}
