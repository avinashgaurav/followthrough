import { env } from "../config.ts";

/**
 * Email sign-in through Supabase Auth's REST API. Supabase sends the email:
 * a link (default templates) and, once the templates include {{ .Token }}, a
 * code. This server asks for the email, then checks either the typed code or
 * the access token the link hands back. No Supabase session is kept: a proven
 * email opens our own session.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class AuthProviderError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function config(): { url: string; key: string } {
  const url = env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new AuthProviderError("Sign-in is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).", 503);
  return { url, key };
}

async function call(path: string, body: unknown, fetchImpl: FetchLike) {
  const { url, key } = config();
  return fetchImpl(`${url}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Emails a sign-in link (and a code, once the email templates include
 * {{ .Token }}); creates the Supabase Auth user on first use. The link brings
 * the person back to `redirectTo`, which must be in the project's Redirect URLs.
 */
export async function sendCode(
  email: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  redirectTo?: string,
): Promise<void> {
  const path = redirectTo ? `otp?redirect_to=${encodeURIComponent(redirectTo)}` : "otp";
  const res = await call(path, { email, create_user: true }, fetchImpl);
  if (res.ok) return;
  const text = (await res.text()).slice(0, 300);
  if (res.status === 429) throw new AuthProviderError("Too many codes requested. Wait a minute and try again.", 429);
  console.warn(`supabase otp failed (${res.status}): ${text}`);
  throw new AuthProviderError("Could not send the sign-in email. Try again in a minute.", 502);
}

/** True when the code is valid for this email. */
export async function verifyCode(
  email: string,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  const res = await call("verify", { type: "email", email, token: code }, fetchImpl);
  if (res.ok) return true;
  if (res.status >= 500) {
    console.warn(`supabase verify failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  return false; // 400/401/403: wrong or expired code
}

/** How Supabase says a session was obtained (JWT "amr"). Only these prove the inbox. */
const INBOX_METHODS = new Set(["otp", "magiclink", "email/signup"]);
/** A link sign-in must be used within this long of Supabase confirming it. */
const LINK_FRESH_MS = 10 * 60_000;

function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * The email behind a Supabase access token from an emailed link, checked with
 * Supabase itself. Null unless all hold: Supabase accepts the token; the email
 * is confirmed; the user signs in by email (not password or OAuth); the token
 * came from an email link or code (amr), so it proves the inbox even if the
 * shared project allows other sign-up routes; and that sign-in happened in the
 * last 10 minutes, so an old or leaked token is not a sign-in credential here.
 */
export async function emailForAccessToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<string | null> {
  const { url, key } = config();
  const res = await fetchImpl(`${url}/auth/v1/user`, {
    method: "GET",
    headers: { apikey: key, authorization: `Bearer ${accessToken}` },
  });
  if (res.status >= 500) {
    console.warn(`supabase user lookup failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  if (!res.ok) return null;
  let user: {
    email?: string;
    email_confirmed_at?: string | null;
    last_sign_in_at?: string | null;
    app_metadata?: { provider?: string };
  };
  try {
    user = JSON.parse(await res.text());
  } catch {
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  if (!user.email || !user.email_confirmed_at) return null;
  if (user.app_metadata?.provider !== "email") return null;
  // Supabase already verified the signature; the payload is read, not trusted alone.
  const amr = (jwtPayload(accessToken)?.amr ?? []) as Array<{ method?: string }>;
  if (!Array.isArray(amr) || !amr.some((m) => INBOX_METHODS.has(m?.method ?? ""))) return null;
  const signedIn = Date.parse(user.last_sign_in_at ?? "");
  if (!Number.isFinite(signedIn) || now - signedIn > LINK_FRESH_MS) return null;
  return user.email.trim().toLowerCase();
}
