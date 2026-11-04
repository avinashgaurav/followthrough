import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb, nowIso, withTenant } from "../db.ts";
import { ulid } from "../ids.ts";
import { env, hostedMode, withProduct } from "../config.ts";
import { readSessionCookie, sessionCookie } from "../auth.ts";
import { clientIp } from "../demo.ts";
import { AuthProviderError, emailForAccessToken, sendCode, verifyCode, type FetchLike } from "./supabase-auth.ts";
import {
  AlreadyMemberError,
  SignupsFullError,
  controlHitCount,
  evictUnverifiedClaim,
  isUnverifiedClaim,
  recordControlHit,
  withdrawControlHit,
  acceptInvite,
  removeMember,
  type Membership,
  controlRateLimited,
  createWorkspace,
  currentWorkspaceId,
  getWorkspace,
  membershipFor,
  openSession,
  workspaceForSession,
  type Workspace,
} from "./tenancy.ts";

/**
 * Hosted sign-up and sign-in (HOSTED_MODE). Email plus a one-time code from
 * Supabase Auth; a first-time email names its workspace, which gets its own
 * schema. Every other request is pinned to the caller's workspace by
 * hostedDispatch before any route runs.
 */

let authFetch: FetchLike | undefined;
/** Test seam for the Supabase Auth calls. */
export function setAuthFetch(f: FetchLike | undefined): void {
  authFetch = f;
}

const HOUR = 3_600_000;
const SIGNUP_TOKEN_TTL_MS = 30 * 60_000;

/** Routes that run outside any workspace. Everything else needs a session. */
const OUTSIDE_WORKSPACE = new Set([
  "/api/health",
  "/api/auth/config",
  "/api/cron/daily",
  "/api/hosted/config",
  "/api/hosted/send-code",
  "/api/hosted/verify",
  "/api/hosted/create-workspace",
  "/api/hosted/accept-invite",
  "/api/hosted/link-verify",
  "/api/hosted/password-signup",
  "/api/hosted/password-login",
]);

/** Single-tenant features that would act with this deployment's credentials or files. */
function blockedWhenHosted(method: string, path: string): boolean {
  if (method === "POST" && path === "/api/auth/login") return true; // admin-issued codes; hosted uses email codes
  if (path.startsWith("/api/watchfolder")) return true;
  // Would read the operator's RELEASE_REPO with the operator's GitHub token.
  if (path === "/api/releases/poll") return true;
  // iCal feeds are fetched server-side; off until redirects and private
  // addresses are checked at fetch time, not only when the URL is saved.
  if (path.startsWith("/api/calendar")) return true;
  return false;
}

/** Where emailed links send people back. Configured, never taken from a request. */
function appOrigin(): string | null {
  return env.APP_URL ? new URL(env.APP_URL).origin : null;
}

/**
 * Sign-in POSTs must be JSON from the app's own pages: no cross-site form can
 * sign a browser into someone else's workspace (login CSRF). Requests without
 * an Origin header (non-browser clients) are allowed; a mismatched one is not.
 */
function crossSiteRefusal(req: Request): Response | null {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return json({ error: "Send JSON." }, 415);
  }
  const app = appOrigin();
  if (!app) return json({ error: "Sign-in is not configured (APP_URL)." }, 503);
  const origin = req.headers.get("origin");
  if (origin && origin !== app) return json({ error: "Cross-site request refused." }, 403);
  if (req.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Cross-site request refused." }, 403);
  return null;
}

/**
 * Throttle key and limit for the caller's IP. Password endpoints never skip
 * the IP limit: an unknown IP (TRUSTED_PROXY_HOPS misconfigured) shares one
 * bucket with a larger limit, so it neither bypasses nor trivially blocks.
 */
function ipBucket(prefix: string, req: Request, limit: number): { key: string; limit: number } {
  const own = ipKey(prefix, req);
  return own ? { key: own, limit } : { key: `${prefix}:unknown-ip`, limit: limit * 10 };
}

/** Throttle key for the caller's IP, or null (skip the IP bucket) when it is unknown. */
function ipKey(prefix: string, req: Request): string | null {
  const ip = clientIp(req);
  return ip ? `${prefix}:${ip}` : null;
}

function secure(req: Request): boolean {
  return req.url.startsWith("https") || req.headers.get("x-forwarded-proto") === "https";
}

function inWorkspace<T>(ws: Workspace, fn: () => Promise<T>): Promise<T> {
  return withTenant(ws.schema_name, () =>
    withProduct({ name: ws.product_name, description: ws.product_description }, fn),
  );
}

export async function hostedDispatch(
  req: Request,
  dispatch: (req: Request) => Promise<Response | null>,
): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  if (OUTSIDE_WORKSPACE.has(path)) return dispatch(req);
  if (blockedWhenHosted(req.method, path)) {
    return json({ error: "Not available on the hosted app." }, 404);
  }
  const db = getDb();

  // Public client page: the token names its workspace ("<workspaceId>.<secret>").
  if (path.startsWith("/share/")) {
    let token: string;
    try {
      token = decodeURIComponent(path.slice("/share/".length));
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const wsId = token.split(".")[0] ?? "";
    const ws = /^[0-9A-Z]{26}$/.test(wsId) ? await getWorkspace(db, wsId) : null;
    if (!ws) return new Response("Not found", { status: 404 });
    return inWorkspace(ws, () => dispatch(req));
  }

  const ws = await workspaceForSession(db, readSessionCookie(req));
  if (!ws) return json({ error: "unauthorized" }, 401);
  return inWorkspace(ws, () => dispatch(req));
}

// ---------------------------------------------------------------- routes

const EmailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const VerifySchema = EmailSchema.extend({ code: z.string().trim().regex(/^\d{6,10}$/) });
const CreateSchema = z.object({
  signup_token: z.string().min(20),
  product_name: z.string().trim().min(1).max(80),
  product_description: z.string().trim().max(160).optional(),
});

async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => null);
}

function hostedOnly(): Response | null {
  return hostedMode() ? null : json({ error: "not found" }, 404);
}

route("GET", "/api/hosted/config", "public", async () => {
  if (!hostedMode()) return json({ hosted: false });
  const { n } = (await getDb().query("SELECT COUNT(*) AS n FROM control.workspaces").get()) as { n: number };
  return json({ hosted: true, free_meetings: env.FREE_MEETINGS_PER_WORKSPACE, signups_open: n < env.MAX_WORKSPACES });
});

route("POST", "/api/hosted/send-code", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const origin = appOrigin();
  if (!origin) return json({ error: "Sign-in is not configured (APP_URL)." }, 503);
  const body = EmailSchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Enter a valid email address." }, 400);
  const db = getDb();
  const ipBucket = ipKey("code-ip", req);
  if (
    (ipBucket && (await controlRateLimited(db, ipBucket, 10, HOUR))) ||
    (await controlRateLimited(db, `code-email:${body.data.email}`, 5, HOUR))
  ) {
    return json({ error: "Too many codes requested. Try again in an hour." }, 429);
  }
  try {
    await sendCode(body.data.email, authFetch, `${origin}/auth/callback`);
  } catch (err) {
    if (err instanceof AuthProviderError) return json({ error: err.message }, err.status);
    throw err;
  }
  return json({ ok: true });
});

route("POST", "/api/hosted/verify", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = VerifySchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Enter the code from the email." }, 400);
  const db = getDb();
  const { email, code } = body.data;
  const ipBucket = ipKey("verify-ip", req);
  if (
    (await controlRateLimited(db, `verify:${email}`, 10, HOUR)) ||
    (ipBucket && (await controlRateLimited(db, ipBucket, 30, HOUR)))
  ) {
    return json({ error: "Too many attempts. Request a new code in an hour." }, 429);
  }
  let ok: boolean;
  try {
    ok = await verifyCode(email, code, authFetch);
  } catch (err) {
    if (err instanceof AuthProviderError) return json({ error: err.message }, err.status);
    throw err;
  }
  if (!ok) return json({ error: "That code is wrong or has expired." }, 401);

  return completeSignIn(req, email);
});

/**
 * After the email is proven (code or link): an active member gets a session;
 * a new email or a pending invite gets a single-use token for the next step.
 */
async function completeSignIn(req: Request, email: string): Promise<Response> {
  const db = getDb();
  // The inbox is proven here. An unverified password account on this email
  // must not receive the verified person: evict it, then continue as new.
  if (await isUnverifiedClaim(db, email)) await evictUnverifiedClaim(db, email);
  const member = await membershipFor(db, email);
  if (!member || member.status === "invited") {
    const token = ulid() + ulid();
    await db
      .query("INSERT INTO control.pending_signups (token, email, expires_at) VALUES (?, ?, ?)")
      .run(token, email, new Date(Date.now() + SIGNUP_TOKEN_TTL_MS).toISOString());
    if (member) {
      // An invite never signs anyone in by itself: show who invited them and
      // let them join, or decline by creating their own workspace.
      return json({
        invite: { workspace: member.workspace.name, invited_by: member.invitedBy },
        needs_workspace: true,
        signup_token: token,
      });
    }
    return json({ needs_workspace: true, signup_token: token });
  }
  const sid = await openSession(db, member.workspace, member.userId, {
    ip: clientIp(req),
    userAgent: req.headers.get("user-agent"),
  });
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(sid, secure(req)) });
}

route("POST", "/api/hosted/link-verify", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = z.object({ access_token: z.string().min(20).max(4096) }).safeParse(await readJson(req));
  if (!body.success) return json({ error: "That sign-in link is incomplete. Request a new one." }, 400);
  const db = getDb();
  const ipBucket = ipKey("link-ip", req);
  if (ipBucket && (await controlRateLimited(db, ipBucket, 30, HOUR))) {
    return json({ error: "Too many attempts. Try again in an hour." }, 429);
  }
  let email: string | null;
  try {
    email = await emailForAccessToken(body.data.access_token, authFetch);
  } catch (err) {
    if (err instanceof AuthProviderError) return json({ error: err.message }, err.status);
    throw err;
  }
  if (!email) return json({ error: "That sign-in link is invalid or has expired. Request a new one." }, 401);
  return completeSignIn(req, email);
});

route("POST", "/api/hosted/create-workspace", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = CreateSchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Name your company or product (up to 80 characters)." }, 400);
  const db = getDb();
  const pending = await takeSignupToken(body.data.signup_token);
  if (!pending) return json({ error: "That sign-up link expired. Request a new code." }, 401);
  // Creating your own workspace declines a pending invite.
  const invited = await membershipFor(db, pending.email);
  if (invited?.status === "invited") await declineInvite(invited, pending.email);
  try {
    const { workspace, userId } = await createWorkspace(db, {
      email: pending.email,
      productName: body.data.product_name,
      productDescription: body.data.product_description ?? null,
    });
    const sid = await openSession(db, workspace, userId, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    return json({ ok: true }, 201, { "set-cookie": sessionCookie(sid, secure(req)) });
  } catch (err) {
    if (err instanceof SignupsFullError) {
      return json({ error: "Sign-ups are full for now. Star the repo on GitHub and self-host it today." }, 403);
    }
    if (err instanceof AlreadyMemberError) return json({ error: "That email already has a workspace. Sign in instead." }, 409);
    throw err;
  }
});

/** Single use: delete and read back in one statement. */
async function takeSignupToken(token: string): Promise<{ email: string } | null> {
  return (await getDb()
    .query("DELETE FROM control.pending_signups WHERE token = ? AND expires_at > ? RETURNING email")
    .get(token, nowIso())) as { email: string } | null;
}

async function declineInvite(m: Membership, email: string): Promise<void> {
  const db = getDb();
  await removeMember(db, email);
  await withTenant(m.workspace.schema_name, () =>
    db.query("UPDATE users SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL").run(nowIso(), m.userId),
  );
}

route("POST", "/api/hosted/accept-invite", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = z.object({ signup_token: z.string().min(20) }).safeParse(await readJson(req));
  if (!body.success) return json({ error: "Request a new code." }, 400);
  const pending = await takeSignupToken(body.data.signup_token);
  if (!pending) return json({ error: "That link expired. Request a new code." }, 401);
  const db = getDb();
  const m = await membershipFor(db, pending.email);
  if (!m || m.status !== "invited") return json({ error: "There is no pending invite for this email." }, 404);
  await acceptInvite(db, pending.email);
  const sid = await openSession(db, m.workspace, m.userId, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(sid, secure(req)) });
});

// Inside the caller's workspace (hostedDispatch pinned it).
route("GET", "/api/hosted/workspace", "user", async () => {
  const off = hostedOnly();
  if (off) return off;
  const ws = await getWorkspace(getDb(), currentWorkspaceId() ?? "");
  if (!ws) return json({ error: "not found" }, 404);
  return json({
    name: ws.name,
    product_name: ws.product_name,
    product_description: ws.product_description,
    meetings_used: ws.meetings_used,
    meetings_quota: ws.meetings_quota,
  });
});

const ProductSchema = z.object({
  product_name: z.string().trim().min(1).max(80),
  product_description: z.string().trim().max(160).nullable().optional(),
});

route("PATCH", "/api/hosted/workspace", "admin", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const body = ProductSchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Name your company or product (up to 80 characters)." }, 400);
  await getDb()
    .query("UPDATE control.workspaces SET product_name = ?, product_description = ? WHERE id = ?")
    .run(body.data.product_name, body.data.product_description || null, currentWorkspaceId());
  return json({ ok: true });
});

// ---------------------------------------------------------------- email + password (open sign-up)

/**
 * Open sign-up while no email sender is connected (issue #24): an email and a
 * password create a workspace at once. The email is NOT verified, so:
 * - an email that already has an account or a pending invite cannot be taken;
 * - a password belongs to one membership and dies with it (FK cascade), and
 *   login checks it still matches that membership;
 * - a later verified sign-in for the email evicts the password claim
 *   (completeSignIn), so a squatter never receives the real owner.
 * Signup also answers "taken" for existing emails: accepted, since with no
 * email there is no non-revealing way to refuse (documented in HOSTED.md).
 */
const PasswordSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10).max(200),
  product_name: z.string().trim().min(1).max(80),
  product_description: z.string().trim().max(160).optional(),
});
const PasswordLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

/** OWASP argon2id baseline: 19 MiB, 2 passes. Fixed so cost does not drift with Bun's defaults. */
const ARGON = { algorithm: "argon2id", memoryCost: 19_456, timeCost: 2 } as const;
const hashPassword = (pw: string) => Bun.password.hash(pw, ARGON);

// Computed at load, not on the first miss, so a cold instance does not time an
// unknown email differently. If hashing ever failed, "" makes verify throw,
// which is caught below and counts as a wrong password.
const decoyHash: Promise<string> = hashPassword("decoy-password-for-timing").catch(() => "");

const COMMON = new Set([
  "password123", "password1234", "1234567890", "123456789a", "qwertyuiop", "iloveyou123",
  "passw0rd123", "welcome123", "letmein123", "admin12345", "abcdefghij", "0987654321",
]);
function weakPassword(pw: string, email: string): boolean {
  const low = pw.toLowerCase();
  const local = email.split("@")[0] ?? "";
  return COMMON.has(low) || /^(.)\1+$/.test(pw) || (local.length >= 4 && low.includes(local));
}

route("POST", "/api/hosted/password-signup", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = PasswordSignupSchema.safeParse(await readJson(req));
  if (!body.success) {
    const pw = body.error.issues.some((i) => i.path[0] === "password");
    return json(
      { error: pw ? "Use a password of at least 10 characters." : "Enter your email, a password and your company or product." },
      400,
    );
  }
  const { email, password } = body.data;
  if (weakPassword(password, email)) {
    return json({ error: "That password is too easy to guess. Pick something longer or less common." }, 400);
  }
  const db = getDb();
  const ip = ipBucket("signup-ip", req, 10);
  if (await controlRateLimited(db, ip.key, ip.limit, HOUR)) {
    return json({ error: "Too many sign-ups from here. Try again in an hour." }, 429);
  }
  if ((await membershipFor(db, email)) || (await isUnverifiedClaim(db, email))) {
    return json({ error: "That email already has an account. Sign in instead." }, 409);
  }
  // Deployment-wide cap, counted only for requests that are about to create
  // an account, so junk requests cannot use it up for everyone.
  if (await controlRateLimited(db, "signup-global", 30, HOUR)) {
    return json({ error: "Sign-ups are busy right now. Try again in a little while." }, 429);
  }
  try {
    const { workspace, userId } = await createWorkspace(db, {
      email,
      productName: body.data.product_name,
      productDescription: body.data.product_description ?? null,
      passwordHash: await hashPassword(password),
    });
    const sid = await openSession(db, workspace, userId, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
    return json({ ok: true }, 201, { "set-cookie": sessionCookie(sid, secure(req)) });
  } catch (err) {
    if (err instanceof SignupsFullError) {
      return json({ error: "Sign-ups are full for now. Star the repo on GitHub and self-host it today." }, 403);
    }
    if (err instanceof AlreadyMemberError) return json({ error: "That email already has an account. Sign in instead." }, 409);
    throw err;
  }
});

route("POST", "/api/hosted/password-login", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const refused = crossSiteRefusal(req);
  if (refused) return refused;
  const body = PasswordLoginSchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Enter your email and password." }, 400);
  const db = getDb();
  const { email, password } = body.data;
  const ip = ipBucket("login-ip", req, 50);
  if (await controlRateLimited(db, ip.key, ip.limit, HOUR)) {
    return json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
  }
  // Failed attempts only, keyed on email + IP, so a stranger cannot lock
  // someone else out; a loose per-email ceiling backs it. The attempt is
  // recorded BEFORE the password check (parallel guesses all count) and
  // withdrawn if it succeeds.
  const failKey = `login-fail:${email}:${ip.key}`;
  const failAt = await recordControlHit(db, failKey);
  const emailFailAt = await recordControlHit(db, `login-fail:${email}`);
  if (
    (await controlHitCount(db, failKey, 15 * 60_000)) > 10 ||
    (await controlHitCount(db, `login-fail:${email}`, 24 * HOUR)) > 300
  ) {
    return json({ error: "Too many attempts. Wait 15 minutes and try again." }, 429);
  }
  const cred = (await db
    .query("SELECT password_hash, workspace_id, user_id FROM control.credentials WHERE email = ?")
    .get(email)) as { password_hash: string; workspace_id: string; user_id: string } | null;
  const ok = await Bun.password.verify(password, cred?.password_hash || (await decoyHash)).catch(() => false);
  const member = cred && ok ? await membershipFor(db, email) : null;
  const matches =
    !!member && member.status === "active" && member.workspace.id === cred!.workspace_id && member.userId === cred!.user_id;
  if (!matches) return json({ error: "That email and password don't match." }, 401);
  await withdrawControlHit(db, failKey, failAt);
  await withdrawControlHit(db, `login-fail:${email}`, emailFailAt);
  await db
    .query("UPDATE control.credentials SET last_login_at = ? WHERE email = ? AND workspace_id = ?")
    .run(nowIso(), email, cred!.workspace_id);
  const sid = await openSession(db, member!.workspace, member!.userId, { ip: clientIp(req), userAgent: req.headers.get("user-agent") });
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(sid, secure(req)) });
});
