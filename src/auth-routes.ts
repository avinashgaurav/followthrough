import { z } from "zod";
import { getDb, nowIso } from "./db.ts";
import { ulid } from "./ids.ts";
import { route, json } from "./router.ts";
import {
  login,
  logout,
  readSessionCookie,
  sessionCookie,
  generateLoginCode,
  hashCode,
  revokeCode,
  isAllowedEmail,
  isGuestUser,
  GUEST_USER_ID,
} from "./auth.ts";
import { allowedEmailDomains, demoMode, hostedMode, writableRepos } from "./config.ts";
import {
  AlreadyMemberError,
  TooManyMembersError,
  addMember,
  currentWorkspaceId,
  removeMemberByUser,
} from "./hosted/tenancy.ts";
import { clientIp } from "./demo.ts";
import { authRequired, loginForcedByEnv, setAuthRequired } from "./settings.ts";
import { appendEvent } from "./events.ts";

/** Is there a real (non-guest) account that can actually log in? Gates require_login. */
async function hasLoginCapableUser(db: ReturnType<typeof getDb>): Promise<boolean> {
  const row = await db
    .query(
      "SELECT COUNT(*) AS n FROM users WHERE code_hash IS NOT NULL AND disabled_at IS NULL AND id != ?",
    )
    .get(GUEST_USER_ID) as { n: number };
  return row.n > 0;
}

const LoginSchema = z.object({ email: z.string().email(), code: z.string().min(4) });

route("POST", "/api/auth/login", "public", async (req) => {
  const db = getDb();
  const body = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "email and code required" }, 400);
  // Proxy-appended XFF entry per TRUSTED_PROXY_HOPS (see clientIp).
  const ip = clientIp(req);
  const result = await login(db, body.data.email, body.data.code, ip, req.headers.get("user-agent"));
  if (!result.ok) {
    const status = result.reason === "locked_out" ? 429 : 401;
    return json(
      { error: result.reason === "locked_out" ? "Too many attempts. Try again later." : "Invalid email or code." },
      status,
    );
  }
  return json({ userId: result.userId, role: result.role }, 200, {
    "set-cookie": sessionCookie(
      result.sessionId,
      // The tunnel/proxy terminates TLS; the local request is plain http.
      req.url.startsWith("https") || req.headers.get("x-forwarded-proto") === "https",
    ),
  });
});

route("POST", "/api/auth/logout", "user", async (req) => {
  const sid = readSessionCookie(req);
  if (sid) await logout(getDb(), sid);
  // Match the attributes the cookie was set with, Secure included on https.
  const secure = req.url.startsWith("https") || req.headers.get("x-forwarded-proto") === "https";
  return json({ ok: true }, 200, {
    "set-cookie": `ie_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  });
});

route("GET", "/api/me", "user", async (_req, user) =>
  json({
    user,
    require_login: await authRequired(getDb()),
    is_guest: isGuestUser(user),
    allowed_email_domains: allowedEmailDomains(),
    writable_repos: writableRepos(),
    demo: demoMode(),
    hosted: hostedMode(),
  }),
);

// Public: the login screen needs the domain rule before anyone is signed in.
route("GET", "/api/auth/config", "public", () =>
  json({ allowed_email_domains: allowedEmailDomains() }),
);

// Access mode: read + toggle whether login is required (admin only).
// forced_by_server: login is on because of the environment (REQUIRE_LOGIN or a
// public deployment), so the in-app toggle cannot open the app.
route("GET", "/api/settings/access", "admin", async () => {
  const db = getDb();
  return json({
    require_login: await authRequired(db),
    can_require: await hasLoginCapableUser(db),
    forced_by_server: loginForcedByEnv(),
  });
});

const AccessSchema = z.object({ require_login: z.boolean() });

route("POST", "/api/settings/access", "admin", async (req, admin) => {
  const db = getDb();
  const body = AccessSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "require_login (boolean) required" }, 400);
  if (!body.data.require_login && loginForcedByEnv()) {
    return json({ error: "Login is required by this server's REQUIRE_LOGIN setting, so it can't be turned off here." }, 400);
  }
  // Anti-lockout: do not let anyone turn login ON until a real account with a
  // login code exists, or everyone (including this guest) would be locked out.
  if (body.data.require_login && !await hasLoginCapableUser(db)) {
    return json(
      { error: "Add a teammate with a login code first, or you would lock everyone out." },
      400,
    );
  }
  const actor = isGuestUser(admin) ? null : admin!.id;
  await setAuthRequired(db, body.data.require_login, actor);
  await appendEvent(db, {
    actorUserId: actor,
    entityType: "user",
    entityId: admin!.id,
    eventType: body.data.require_login ? "access.login_required" : "access.opened",
  });
  return json({ require_login: body.data.require_login });
});

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["admin", "member"]).default("member"),
});

route("POST", "/api/users", "admin", async (req, admin) => {
  const db = getDb();
  const body = CreateUserSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: body.error.flatten() }, 400);
  if (!isAllowedEmail(body.data.email)) {
    const domains = allowedEmailDomains().map((d) => `@${d}`).join(", ");
    return json({ error: `Only ${domains} emails can have accounts.` }, 400);
  }
  const code = generateLoginCode();
  const id = ulid();
  await db.query(
    "INSERT INTO users (id, email, name, role, code_hash, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, body.data.email.toLowerCase(), body.data.name, body.data.role, await hashCode(code), admin!.id, nowIso());
  // Hosted: record an invite. It grants nothing until the invitee signs in
  // with their own email code and accepts. Refused (and the user row undone)
  // if the email is taken or the workspace is full; the message does not say
  // which, so admins cannot probe who else uses Followthrough.
  const ws = hostedMode() ? currentWorkspaceId() : null;
  if (ws) {
    try {
      await addMember(db, ws, body.data.email, id, admin!.email);
    } catch (err) {
      await db.query("DELETE FROM users WHERE id = ?").run(id);
      if (err instanceof AlreadyMemberError || err instanceof TooManyMembersError) {
        return json({ error: "That email can't be invited to this workspace." }, 409);
      }
      throw err;
    }
  }
  await appendEvent(db, {
    actorUserId: admin!.id,
    entityType: "user",
    entityId: id,
    eventType: "user.created",
    payload: { email: body.data.email, role: body.data.role },
  });
  // Shown once to the admin; never stored in plaintext.
  return json({ id, loginCode: code }, 201);
});

route("GET", "/api/users", "admin", async () => {
  const users = await getDb()
    .query(
      "SELECT id, email, name, role, created_at, disabled_at, (code_hash IS NOT NULL) AS has_code FROM users WHERE id != ?",
    )
    .all(GUEST_USER_ID);
  return json({ users });
});

route("POST", "/api/users/:id/rotate-code", "admin", async (_req, admin, params) => {
  // The open-access guest is not a real account; never issue it a code.
  if (params.id === GUEST_USER_ID) return json({ error: "Cannot rotate the open-access guest." }, 400);
  const db = getDb();
  const code = generateLoginCode();
  // Issuing a fresh code also re-enables a previously-revoked account.
  const res = await db
    .query("UPDATE users SET code_hash = ?, code_rotated_at = ?, disabled_at = NULL WHERE id = ?")
    .run(await hashCode(code), nowIso(), params.id!);
  if (res.changes === 0) return json({ error: "user not found" }, 404);
  await appendEvent(db, { actorUserId: admin!.id, entityType: "user", entityId: params.id!, eventType: "user.code_rotated" });
  return json({ loginCode: code });
});

route("POST", "/api/users/:id/revoke", "admin", async (_req, admin, params) => {
  // Disabling the open-access guest would transiently 401 every signed-out user
  // (the session/user lookups filter disabled_at). The guest is system-managed.
  if (params.id === GUEST_USER_ID) return json({ error: "Cannot revoke the open-access guest." }, 400);
  if (params.id === admin!.id) return json({ error: "You can't revoke your own access." }, 400);
  const db = getDb();
  await revokeCode(db, params.id!);
  // Hosted: free the email so the person can sign in elsewhere.
  const ws = hostedMode() ? currentWorkspaceId() : null;
  if (ws) await removeMemberByUser(db, ws, params.id!);
  await appendEvent(db, { actorUserId: admin!.id, entityType: "user", entityId: params.id!, eventType: "user.code_revoked" });
  return json({ ok: true });
});
