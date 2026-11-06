// Run by the root `bun test`; excluded from the web tsconfig (no bun types there).
import { describe, expect, test } from "bun:test";
import { scrubPageView } from "./analytics";

const send = (url: string) => scrubPageView({ type: "pageview", url })?.url ?? null;

describe("scrubPageView", () => {
  test("drops the auth callback and anything under /auth/", () => {
    expect(send("https://app.example.com/auth/callback?token=abc#x")).toBeNull();
    expect(send("https://app.example.com/auth/other")).toBeNull();
  });

  test("strips query and hash", () => {
    expect(send("https://app.example.com/review?tab=open#top")).toBe("https://app.example.com/review");
  });

  test("replaces record ids on detail routes", () => {
    expect(send("https://app.example.com/meetings/01JBXYZ0000000000000000000")).toBe(
      "https://app.example.com/meetings/:id",
    );
    expect(send("https://app.example.com/insights/a")).toBe("https://app.example.com/insights/:id");
    expect(send("https://app.example.com/clients/c1?x=1")).toBe("https://app.example.com/clients/:id");
  });

  test("replaces id-like trailing segments elsewhere", () => {
    expect(send("https://app.example.com/x/123e4567-e89b-12d3-a456-426614174000")).toBe(
      "https://app.example.com/x/:id",
    );
    expect(send("https://app.example.com/x/deadbeefdeadbeef")).toBe("https://app.example.com/x/:id");
    expect(send("https://app.example.com/x/123456")).toBe("https://app.example.com/x/:id");
  });

  test("keeps neutral pages as they are", () => {
    expect(send("https://app.example.com/")).toBe("https://app.example.com/");
    expect(send("https://app.example.com/insights")).toBe("https://app.example.com/insights");
    expect(send("https://app.example.com/numbers")).toBe("https://app.example.com/numbers");
  });
});
