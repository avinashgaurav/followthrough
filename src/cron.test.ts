import { describe, expect, test } from "bun:test";
import { cronAuthorized } from "./cron.ts";
import { restorePath } from "../api/server.ts";

describe("cron auth", () => {
  const req = (auth?: string) => new Request("https://x/api/cron/daily", auth ? { headers: { authorization: auth } } : {});
  test("needs the exact bearer secret", () => {
    expect(cronAuthorized(req("Bearer s3cret"), "s3cret")).toBe(true);
    expect(cronAuthorized(req("Bearer wrong"), "s3cret")).toBe(false);
    expect(cronAuthorized(req(), "s3cret")).toBe(false);
  });
  test("refuses everything when no secret is configured", () => {
    expect(cronAuthorized(req("Bearer "), undefined)).toBe(false);
    expect(cronAuthorized(req("Bearer undefined"), undefined)).toBe(false);
  });
});

describe("Vercel entry", () => {
  test("restores the original path from __path and keeps the other query params", () => {
    const r = restorePath(new Request("https://app.example/api/server?__path=/api/meetings&client_id=c1"));
    const u = new URL(r.url);
    expect(u.pathname).toBe("/api/meetings");
    expect(u.searchParams.get("client_id")).toBe("c1");
    expect(u.searchParams.has("__path")).toBe(false);
  });
  test("a client-supplied __path after the rewrite's is ignored and stripped", () => {
    const r = restorePath(new Request("https://app.example/api/server?__path=/api/health&__path=/api/admin&x=1"));
    const u = new URL(r.url);
    expect(u.pathname).toBe("/api/health");
    expect(u.searchParams.getAll("__path")).toEqual([]);
    expect(u.searchParams.get("x")).toBe("1");
  });

  test("leaves a request without __path alone", () => {
    const req = new Request("https://app.example/api/health");
    expect(restorePath(req)).toBe(req);
  });
});
