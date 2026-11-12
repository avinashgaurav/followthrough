import { describe, expect, test } from "bun:test";
import {
  FeedTooLargeError,
  MAX_BODY_BYTES,
  UnsafeUrlError,
  isBlockedAddress,
  safeFetchText,
  type Resolver,
} from "./safe-fetch.ts";

const PUBLIC = "93.184.216.34";

/** Resolver from a fixed table; unknown names fail like NXDOMAIN. */
function dns(table: Record<string, string[]>): Resolver & { asked: string[] } {
  const asked: string[] = [];
  return Object.assign(
    async (host: string) => {
      asked.push(host);
      const hit = table[host];
      if (!hit) throw new Error("ENOTFOUND");
      return hit;
    },
    { asked },
  );
}

/** Fetch stub answering by URL; records every URL requested. */
function routes(table: Record<string, () => Response>): { impl: typeof fetch; requested: string[] } {
  const requested: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requested.push(url);
    expect(init?.redirect).toBe("manual");
    const make = table[url];
    if (!make) throw new Error(`unexpected fetch ${url}`);
    return make();
  }) as unknown as typeof fetch;
  return { impl, requested };
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const ok = (body: string) => () => new Response(body, { status: 200 });

describe("isBlockedAddress", () => {
  test.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "100.127.255.254", "0.0.0.0", "0.1.2.3", "224.0.0.1", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%en0", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "[::1]", "64:ff9b::a00:1", "2002:c0a8:101::1",
    "not-an-ip",
  ])("blocks %s", (addr) => {
    expect(isBlockedAddress(addr)).toBe(true);
  });

  test.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::6810:84e5", "::ffff:8.8.8.8"])(
    "allows %s",
    (addr) => {
      expect(isBlockedAddress(addr)).toBe(false);
    },
  );
});

describe("safeFetchText", () => {
  const opts = (impl: typeof fetch, resolve: Resolver) => ({ fetchImpl: impl, resolve, timeoutMs: 5_000 });

  test("happy path: public host, body returned", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const { impl, requested } = routes({ "https://cal.example.com/a.ics": ok("BEGIN:VCALENDAR") });
    const res = await safeFetchText("https://cal.example.com/a.ics", opts(impl, r));
    expect(res).toEqual({ status: 200, ok: true, text: "BEGIN:VCALENDAR" });
    expect(requested).toEqual(["https://cal.example.com/a.ics"]);
  });

  test("a private IP literal is refused without a request", async () => {
    const { impl, requested } = routes({});
    for (const url of ["https://127.0.0.1/a.ics", "https://169.254.169.254/latest", "https://[::1]/a.ics", "https://2130706433/a.ics"]) {
      await expect(safeFetchText(url, opts(impl, dns({})))).rejects.toThrow(UnsafeUrlError);
    }
    expect(requested).toHaveLength(0);
  });

  test("a hostname that resolves to a private IP is refused", async () => {
    const r = dns({ "evil.example.com": ["10.0.0.5"] });
    const { impl, requested } = routes({});
    await expect(safeFetchText("https://evil.example.com/a.ics", opts(impl, r))).rejects.toThrow(UnsafeUrlError);
    expect(r.asked).toEqual(["evil.example.com"]);
    expect(requested).toHaveLength(0);
  });

  test("refused when ANY resolved address is private (mixed answers)", async () => {
    const r = dns({ "mixed.example.com": [PUBLIC, "::ffff:192.168.0.1"] });
    const { impl } = routes({});
    await expect(safeFetchText("https://mixed.example.com/a.ics", opts(impl, r))).rejects.toThrow(UnsafeUrlError);
  });

  test("a redirect to a private host is refused before it is requested", async () => {
    const r = dns({ "cal.example.com": [PUBLIC], "internal.example.com": ["192.168.1.10"] });
    const { impl, requested } = routes({
      "https://cal.example.com/a.ics": redirect("http://internal.example.com/secret"),
    });
    await expect(safeFetchText("https://cal.example.com/a.ics", opts(impl, r))).rejects.toThrow(UnsafeUrlError);
    expect(requested).toEqual(["https://cal.example.com/a.ics"]);
  });

  test("a redirect to the metadata address literal is refused", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const { impl, requested } = routes({
      "https://cal.example.com/a.ics": redirect("http://169.254.169.254/latest/meta-data/", 307),
    });
    await expect(safeFetchText("https://cal.example.com/a.ics", opts(impl, r))).rejects.toThrow(UnsafeUrlError);
    expect(requested).toHaveLength(1);
  });

  test("up to 3 redirects are followed (relative ones too), each re-checked", async () => {
    const r = dns({ "a.example.com": [PUBLIC], "b.example.com": [PUBLIC] });
    const { impl, requested } = routes({
      "https://a.example.com/1": redirect("https://b.example.com/2", 301),
      "https://b.example.com/2": redirect("/3", 308),
      "https://b.example.com/3": redirect("https://a.example.com/4", 303),
      "https://a.example.com/4": ok("done"),
    });
    const res = await safeFetchText("https://a.example.com/1", opts(impl, r));
    expect(res.text).toBe("done");
    expect(requested).toHaveLength(4);
    expect(r.asked).toEqual(["a.example.com", "b.example.com", "b.example.com", "a.example.com"]);
  });

  test("a 4th redirect is refused", async () => {
    const r = dns({ "a.example.com": [PUBLIC] });
    const { impl, requested } = routes({
      "https://a.example.com/1": redirect("/2"),
      "https://a.example.com/2": redirect("/3"),
      "https://a.example.com/3": redirect("/4"),
      "https://a.example.com/4": redirect("/5"),
      "https://a.example.com/5": ok("never"),
    });
    await expect(safeFetchText("https://a.example.com/1", opts(impl, r))).rejects.toThrow(/too many times/);
    expect(requested).toHaveLength(4);
  });

  test("an oversized body is cut off at 5 MB (streamed, no Content-Length)", async () => {
    const r = dns({ "big.example.com": [PUBLIC] });
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(65);
    const { impl } = routes({
      "https://big.example.com/a.ics": () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulled++;
              if (pulled > 50) c.close();
              else c.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    });
    await expect(safeFetchText("https://big.example.com/a.ics", opts(impl, r))).rejects.toThrow(FeedTooLargeError);
    expect(pulled).toBeLessThan(10); // stopped soon after the cap, not after reading all 50 MB
  });

  test("a declared Content-Length over the cap is refused before reading", async () => {
    const r = dns({ "big.example.com": [PUBLIC] });
    const { impl } = routes({
      "https://big.example.com/a.ics": () =>
        new Response("x", { status: 200, headers: { "content-length": String(MAX_BODY_BYTES + 1) } }),
    });
    await expect(safeFetchText("https://big.example.com/a.ics", opts(impl, r))).rejects.toThrow(FeedTooLargeError);
  });

  test("a body exactly at the cap is accepted", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const body = "A".repeat(1000);
    const { impl } = routes({ "https://cal.example.com/a.ics": ok(body) });
    const res = await safeFetchText("https://cal.example.com/a.ics", { ...opts(impl, r), maxBytes: 1000 });
    expect(res.text).toBe(body);
  });

  test("non-default ports and other schemes are refused", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const { impl, requested } = routes({});
    for (const url of [
      "https://cal.example.com:8443/a.ics",
      "http://cal.example.com:8080/a.ics",
      "https://cal.example.com:80/a.ics",
      "ftp://cal.example.com/a.ics",
      "file:///etc/passwd",
    ]) {
      await expect(safeFetchText(url, opts(impl, r))).rejects.toThrow(UnsafeUrlError);
    }
    expect(requested).toHaveLength(0);
    // Explicit default ports are fine (URL normalises them away).
    const allowed = routes({ "https://cal.example.com/a.ics": ok("x") });
    expect((await safeFetchText("https://cal.example.com:443/a.ics", opts(allowed.impl, r))).ok).toBe(true);
  });

  test("a redirect to a non-default port is refused", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const { impl, requested } = routes({ "https://cal.example.com/a.ics": redirect("https://cal.example.com:6443/x") });
    await expect(safeFetchText("https://cal.example.com/a.ics", opts(impl, r))).rejects.toThrow(UnsafeUrlError);
    expect(requested).toHaveLength(1);
  });

  test("an unresolvable host is refused", async () => {
    const { impl } = routes({});
    await expect(safeFetchText("https://nowhere.example.com/a.ics", opts(impl, dns({})))).rejects.toThrow(UnsafeUrlError);
  });

  test("a non-2xx answer is reported, not thrown", async () => {
    const r = dns({ "cal.example.com": [PUBLIC] });
    const { impl } = routes({ "https://cal.example.com/a.ics": () => new Response("no", { status: 404 }) });
    expect(await safeFetchText("https://cal.example.com/a.ics", opts(impl, r))).toEqual({ status: 404, ok: false, text: "" });
  });

  test("the timeout covers a hung server", async () => {
    const r = dns({ "slow.example.com": [PUBLIC] });
    const impl = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
    await expect(safeFetchText("https://slow.example.com/a.ics", { fetchImpl: impl, resolve: r, timeoutMs: 50 })).rejects.toThrow();
  });
});
