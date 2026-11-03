import { env } from "../config.ts";

/**
 * Email one-time codes through Supabase Auth's REST API. Supabase sends the
 * email (configure SMTP and put {{ .Token }} in the "Magic Link" template so
 * the email carries a code); this server only asks for a code and checks it.
 * No Supabase session is kept: a verified email opens our own session.
 */

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
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

/** Emails a sign-in code; creates the Supabase Auth user on first use. */
export async function sendCode(email: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<void> {
  const res = await call("otp", { email, create_user: true }, fetchImpl);
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
