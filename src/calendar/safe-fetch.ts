import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetch-time SSRF guard for server-side feed fetches (the iCal import).
 *
 * Every hop is checked before it is requested: http(s) only, default ports
 * only, and every address the hostname resolves to must be public. Redirects
 * are followed by hand (at most MAX_REDIRECTS) so each new host is checked
 * too, and the body is streamed with a hard size cap.
 *
 * Known limit: the address checked here comes from our own lookup, and fetch
 * resolves the name again when it connects. A DNS server that answers with a
 * public address and then a private one (DNS rebinding) inside that gap is
 * not caught; closing that needs connecting to the checked address itself,
 * which fetch does not offer for https.
 */

export const MAX_REDIRECTS = 3;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Resolves a hostname to every address it has. Injected in tests. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export class UnsafeUrlError extends Error {}
export class FeedTooLargeError extends Error {}

/** Blocked IPv4 ranges as [network, prefix length]. */
const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including 169.254.169.254 (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including 255.255.255.255
];

function v4ToInt(addr: string): number {
  const p = addr.split(".").map(Number);
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

function v4Blocked(addr: string): boolean {
  const n = v4ToInt(addr);
  return BLOCKED_V4.some(([net, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n & mask) >>> 0) === ((v4ToInt(net) & mask) >>> 0);
  });
}

/** Expands an IPv6 address (no brackets, no zone) to 8 16-bit groups. */
function v6Groups(addr: string): number[] | null {
  let s = addr;
  const tail: number[] = [];
  // Trailing dotted IPv4 (e.g. ::ffff:127.0.0.1) becomes two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) {
    if (isIP(dotted[1]!) !== 4) return null;
    const n = v4ToInt(dotted[1]!);
    tail.push(n >>> 16, n & 0xffff);
    s = s.slice(0, -dotted[1]!.length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const parse = (part: string) => (part === "" ? [] : part.split(":").map((h) => parseInt(h, 16)));
  let groups: number[];
  if (s.includes("::")) {
    const [head, rest] = s.split("::") as [string, string];
    const h = parse(head);
    const r = parse(rest);
    const fill = 8 - tail.length - h.length - r.length;
    if (fill < 0) return null;
    groups = [...h, ...new Array<number>(fill).fill(0), ...r, ...tail];
  } else {
    groups = [...parse(s), ...tail];
  }
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) return null;
  return groups;
}

function embeddedV4(hi: number, lo: number): string {
  return `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;
}

function v6Blocked(addr: string): boolean {
  const g = v6Groups(addr.split("%")[0]!);
  if (!g) return true; // unparseable: refuse rather than guess
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [number, number, number, number, number, number, number, number];
  const firstFourZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  // ::ffff:a.b.c.d (IPv4-mapped): judge the IPv4 address it carries.
  if (firstFourZero && g4 === 0 && g5 === 0xffff) return v4Blocked(embeddedV4(g6, g7));
  // ::ffff:0:a.b.c.d (IPv4-translated, SIIT): same.
  if (firstFourZero && g4 === 0xffff && g5 === 0) return v4Blocked(embeddedV4(g6, g7));
  // 64:ff9b::/96 (well-known NAT64 prefix) carries an IPv4 address in its last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return v4Blocked(embeddedV4(g6, g7));
  }
  // Everything outside 2000::/3 (global unicast) is refused: ::, ::1, the
  // deprecated ::a.b.c.d form, 64:ff9b:1::/48 local NAT64, 100::/64 discard,
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10, ff00::/8 multicast.
  if ((g0 & 0xe000) !== 0x2000) return true;
  // 2001::/23 IETF special purpose, including Teredo (2001::/32), which can
  // tunnel to an arbitrary IPv4 address.
  if (g0 === 0x2001 && g1 < 0x0200) return true;
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 documentation
  // 2002::/16 (6to4) carries an IPv4 address in groups 1 and 2.
  if (g0 === 0x2002) return v4Blocked(embeddedV4(g1, g2));
  if (g0 === 0x3fff && g1 < 0x1000) return true; // 3fff::/20 documentation
  return false;
}

/** True when the address is not a public unicast address. Non-IPs are refused. */
export function isBlockedAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "");
  const kind = isIP(a.split("%")[0]!);
  if (kind === 4) return v4Blocked(a);
  if (kind === 6) return v6Blocked(a);
  return true;
}

/** Checks one URL: scheme, port, and every address its host resolves to. */
export async function assertSafeUrl(url: URL, resolve: Resolver): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https feed links are allowed.");
  }
  // URL drops a default port, so any port left here is a non-default one.
  if (url.port !== "") {
    throw new UnsafeUrlError("Feed links must use the standard port (443 for https, 80 for http).");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UnsafeUrlError("Feed link has no host.");
  // "localhost" and its subdomains are loopback by definition (RFC 6761),
  // whatever a resolver says; a trailing dot is the same name.
  const bare = host.toLowerCase().replace(/\.+$/, "");
  if (bare === "localhost" || bare.endsWith(".localhost")) {
    throw new UnsafeUrlError("Feed link points at a private or internal address.");
  }
  let addresses: string[];
  if (isIP(host)) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new UnsafeUrlError("Could not resolve the feed's host.");
    }
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) {
    throw new UnsafeUrlError("Feed link points at a private or internal address.");
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Reads a body as text, aborting once it passes maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new FeedTooLargeError("Calendar feed is larger than 5 MB.");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new FeedTooLargeError("Calendar feed is larger than 5 MB.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  timeoutMs: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/**
 * GETs a URL with every hop checked, and returns the final response's status
 * and (capped) body text. The timeout covers lookups, every hop and the body.
 * Throws UnsafeUrlError for a refused hop or too many redirects,
 * FeedTooLargeError past the size cap, and the fetch error otherwise.
 */
export async function safeFetchText(
  start: string,
  opts: SafeFetchOptions,
): Promise<{ status: number; ok: boolean; text: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? systemResolver;
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("timed out")), opts.timeoutMs);
  const timedOut = new Promise<never>((_, reject) =>
    abort.signal.addEventListener("abort", () => reject(new Error("calendar feed fetch timed out")), { once: true }),
  );
  timedOut.catch(() => {});

  const run = async () => {
    let url = new URL(start);
    for (let hop = 0; ; hop++) {
      await assertSafeUrl(url, resolve);
      const res = await fetchImpl(url.toString(), { redirect: "manual", signal: abort.signal });
      if (REDIRECTS.has(res.status)) {
        await res.body?.cancel().catch(() => {});
        const location = res.headers.get("location");
        if (!location) return { status: res.status, ok: false, text: "" };
        if (hop >= maxRedirects) throw new UnsafeUrlError("Calendar feed redirected too many times.");
        url = new URL(location, url);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return { status: res.status, ok: false, text: "" };
      }
      return { status: res.status, ok: true, text: await readCapped(res, maxBytes) };
    }
  };

  try {
    return await Promise.race([run(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
