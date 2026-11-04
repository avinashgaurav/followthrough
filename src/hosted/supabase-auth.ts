import { env } from "../config.ts";

/**
 * Email sign-in through Supabase Auth's REST API. Supabase sends the email:
 * a link (default templates) and, once the templates include {{ .Token }}, a
 * code. This server asks for the email, then checks the typed code or the
 * link's token hash with Supabase itself. No Supabase session is kept: a
 * proven email opens our own session.
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

/** A proven link sign-in: the email and a key that marks this link as used. */
export interface LinkProof {
  email: string;
  /** Single-use key for control.used_links (link token hash or Supabase session id). */
  useKey: string;
}

/** Link types an emailed sign-in link may carry. All of them prove the inbox. */
export const LINK_TYPES = new Set(["email", "magiclink", "signup"]);

/**
 * Checks an emailed link's token_hash with Supabase (POST /verify), on the
 * server. This is the inbox proof itself: Supabase only issues the hash in an
 * email, and spends it on first use. Needs the email templates to link to
 * APP_URL/auth/callback?token_hash={{ .TokenHash }}&type=email (docs/HOSTED.md).
 */
export async function emailForTokenHash(
  tokenHash: string,
  type: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<LinkProof | null> {
  if (!LINK_TYPES.has(type)) return null;
  const res = await call("verify", { type, token_hash: tokenHash }, fetchImpl);
  if (res.status >= 500) {
    console.warn(`supabase verify failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  if (!res.ok) return null; // wrong, used or expired link
  let body: { user?: { email?: string } };
  try {
    body = JSON.parse(await res.text());
  } catch {
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  const email = body.user?.email?.trim().toLowerCase();
  if (!email) return null;
  return { email, useKey: `hash:${new Bun.CryptoHasher("sha256").update(tokenHash).digest("hex")}` };
}

/**
 * How Supabase says a session was obtained (JWT "amr"). Only an emailed code or
 * magic link proves the inbox. "email/signup" does not: with "Confirm email"
 * off, anyone can POST /signup for any address and get that amr.
 */
const INBOX_METHODS = new Set(["otp", "magiclink"]);
/** A link sign-in must be used within this long of Supabase issuing the token. */
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
 * Legacy link format (access token in the URL fragment), kept while the email
 * templates still use {{ .ConfirmationURL }}. Null unless all hold: Supabase
 * accepts the token; the email is confirmed; the user signs in by email; the
 * session came from an emailed code or magic link (amr), and that sign-in and
 * the token itself are under 10 minutes old (the token's own times, never the
 * user's last_sign_in_at, which any later sign-in moves). A first-time sign-up
 * by link reports "email/signup" and is refused here: it needs the token_hash
 * link (emailForTokenHash) or the typed code.
 */
export async function emailForAccessToken(
  accessToken: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  now: number = Date.now(),
): Promise<LinkProof | null> {
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
    app_metadata?: { provider?: string };
  };
  try {
    user = JSON.parse(await res.text());
  } catch {
    throw new AuthProviderError("Sign-in is unavailable right now. Try again in a minute.", 502);
  }
  if (!user.email || !user.email_confirmed_at) return null;
  if (user.app_metadata?.provider !== "email") return null;
  // Supabase already verified the signature, so the payload's claims are its own.
  const claims = jwtPayload(accessToken);
  if (!claims) return null;
  const amr = (claims.amr ?? []) as Array<{ method?: string; timestamp?: number }>;
  if (!Array.isArray(amr)) return null;
  // At most 10 minutes old, and at most a minute in the future (clock skew).
  const fresh = (seconds: unknown) =>
    typeof seconds === "number" &&
    Number.isFinite(seconds) &&
    now - seconds * 1000 <= LINK_FRESH_MS &&
    seconds * 1000 - now <= 60_000;
  if (!amr.some((m) => INBOX_METHODS.has(m?.method ?? "") && fresh(m?.timestamp))) return null;
  if (!fresh(claims.iat)) return null;
  const session = typeof claims.session_id === "string" && claims.session_id ? claims.session_id : null;
  const useKey = session
    ? `session:${session}`
    : `token:${new Bun.CryptoHasher("sha256").update(accessToken).digest("hex")}`;
  return { email: user.email.trim().toLowerCase(), useKey };
}
