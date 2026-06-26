import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb, nowIso } from "./db.ts";
import { ulid } from "./ids.ts";
import { login, hashCode, isAllowedEmail } from "./auth.ts";

const PW = "team-shared-password-123";

function seedUser(
  db: Database,
  email: string,
  role: "admin" | "member",
  opts: { codeHash?: string | null; disabled?: boolean } = {},
): string {
  const id = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, code_hash, created_at, disabled_at) VALUES (?, ?, 'X', ?, ?, ?, ?)",
  ).run(id, email.toLowerCase(), role, opts.codeHash ?? null, nowIso(), opts.disabled ? nowIso() : null);
  return id;
}

describe("isAllowedEmail", () => {
  test("only @tallyhall.example passes", () => {
    expect(isAllowedEmail("a@tallyhall.example")).toBe(true);
    expect(isAllowedEmail("A@Tallyhall.COM")).toBe(true);
    expect(isAllowedEmail("a@gmail.com")).toBe(false);
    expect(isAllowedEmail("a@nottallyhall.example.evil.com")).toBe(false);
  });
});

describe("shared-password login", () => {
  test("unknown @tallyhall.example email + shared password → auto-provisions a member and signs in", async () => {
    const db = openTestDb();
    const r = await login(db, "new.person@tallyhall.example", PW, null, null, { accessPassword: PW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("member");
    const u = db.query("SELECT role FROM users WHERE email = 'new.person@tallyhall.example'").get() as { role: string };
    expect(u.role).toBe("member");
    // session row exists for the new user
    const s = db.query("SELECT COUNT(*) n FROM sessions").get() as { n: number };
    expect(s.n).toBe(1);
  });

  test("non-@tallyhall.example email + shared password → rejected, no user created", async () => {
    const db = openTestDb();
    const r = await login(db, "outsider@gmail.com", PW, null, null, { accessPassword: PW });
    expect(r.ok).toBe(false);
    expect((db.query("SELECT COUNT(*) n FROM users").get() as { n: number }).n).toBe(0);
  });

  test("@tallyhall.example + wrong password (no code account) → rejected", async () => {
    const db = openTestDb();
    const r = await login(db, "nope@tallyhall.example", "wrong", null, null, { accessPassword: PW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("invalid");
  });

  test("shared password is REFUSED for an existing admin (no privilege escalation)", async () => {
    const db = openTestDb();
    seedUser(db, "boss@tallyhall.example", "admin");
    const r = await login(db, "boss@tallyhall.example", PW, null, null, { accessPassword: PW });
    expect(r.ok).toBe(false);
  });

  test("shared password is refused for a disabled member", async () => {
    const db = openTestDb();
    seedUser(db, "ex@tallyhall.example", "member", { disabled: true });
    const r = await login(db, "ex@tallyhall.example", PW, null, null, { accessPassword: PW });
    expect(r.ok).toBe(false);
  });

  test("existing member can sign in with the shared password (keeps their role)", async () => {
    const db = openTestDb();
    seedUser(db, "member@tallyhall.example", "member");
    const r = await login(db, "member@tallyhall.example", PW, null, null, { accessPassword: PW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("member");
  });

  test("ACCESS_PASSWORD blank → shared path off, falls through to code path", async () => {
    const db = openTestDb();
    const r = await login(db, "x@tallyhall.example", PW, null, null, { accessPassword: "" });
    expect(r.ok).toBe(false); // no code account, shared path disabled
  });
});

describe("per-user code login (fallback path still works)", () => {
  test("correct personal code signs an admin in", async () => {
    const db = openTestDb();
    seedUser(db, "admin@tallyhall.example", "admin", { codeHash: await hashCode("CODE12345") });
    const r = await login(db, "admin@tallyhall.example", "CODE12345", null, null, { accessPassword: PW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.role).toBe("admin");
  });

  test("wrong personal code is rejected", async () => {
    const db = openTestDb();
    seedUser(db, "admin@tallyhall.example", "admin", { codeHash: await hashCode("CODE12345") });
    const r = await login(db, "admin@tallyhall.example", "BADCODE", null, null, { accessPassword: PW });
    expect(r.ok).toBe(false);
  });
});
