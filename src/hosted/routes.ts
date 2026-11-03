import { z } from "zod";
import { route, json } from "../router.ts";
import { getDb, nowIso, withTenant } from "../db.ts";
import { ulid } from "../ids.ts";
import { env, hostedMode, withProduct } from "../config.ts";
import { readSessionCookie, sessionCookie } from "../auth.ts";
import { clientIp } from "../demo.ts";
import { AuthProviderError, sendCode, verifyCode, type FetchLike } from "./supabase-auth.ts";
import {
  AlreadyMemberError,
  SignupsFullError,
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
  const body = EmailSchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Enter a valid email address." }, 400);
  const db = getDb();
  const ip = clientIp(req) ?? "unknown";
  if (
    (await controlRateLimited(db, `code-ip:${ip}`, 10, HOUR)) ||
    (await controlRateLimited(db, `code-email:${body.data.email}`, 5, HOUR))
  ) {
    return json({ error: "Too many codes requested. Try again in an hour." }, 429);
  }
  try {
    await sendCode(body.data.email, authFetch);
  } catch (err) {
    if (err instanceof AuthProviderError) return json({ error: err.message }, err.status);
    throw err;
  }
  return json({ ok: true });
});

route("POST", "/api/hosted/verify", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
  const body = VerifySchema.safeParse(await readJson(req));
  if (!body.success) return json({ error: "Enter the code from the email." }, 400);
  const db = getDb();
  const { email, code } = body.data;
  if (
    (await controlRateLimited(db, `verify:${email}`, 10, HOUR)) ||
    (await controlRateLimited(db, `verify-ip:${clientIp(req) ?? "unknown"}`, 30, HOUR))
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
});

route("POST", "/api/hosted/create-workspace", "public", async (req) => {
  const off = hostedOnly();
  if (off) return off;
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
