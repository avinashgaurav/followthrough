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
  ALLOWED_EMAIL_DOMAIN,
} from "./auth.ts";
import { appendEvent } from "./events.ts";

const LoginSchema = z.object({ email: z.string().email(), code: z.string().min(4) });

route("POST", "/api/auth/login", "public", async (req) => {
  const db = getDb();
  const body = LoginSchema.safeParse(await req.json().catch(() => null));
  if (!body.success) return json({ error: "email and code required" }, 400);
  const ip = req.headers.get("x-forwarded-for");
  const result = await login(db, body.data.email, body.data.code, ip, req.headers.get("user-agent"));
  if (!result.ok) {
    const status = result.reason === "locked_out" ? 429 : 401;
    return json(
      { error: result.reason === "locked_out" ? "Too many attempts. Try again later." : "Invalid email or code." },
      status,
    );
  }
  return json({ userId: result.userId, role: result.role }, 200, {
    "set-cookie": sessionCookie(result.sessionId, req.url.startsWith("https")),
  });
});

route("POST", "/api/auth/logout", "user", (req) => {
  const sid = readSessionCookie(req);
  if (sid) logout(getDb(), sid);
  return json({ ok: true }, 200, { "set-cookie": "ie_session=; HttpOnly; Path=/; Max-Age=0" });
});

route("GET", "/api/me", "user", (_req, user) => json({ user }));

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
    return json({ error: `Only @${ALLOWED_EMAIL_DOMAIN} emails can have accounts.` }, 400);
  }
  const code = generateLoginCode();
  const id = ulid();
  db.query(
    "INSERT INTO users (id, email, name, role, code_hash, invited_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, body.data.email.toLowerCase(), body.data.name, body.data.role, await hashCode(code), admin!.id, nowIso());
  appendEvent(db, {
    actorUserId: admin!.id,
    entityType: "user",
    entityId: id,
    eventType: "user.created",
    payload: { email: body.data.email, role: body.data.role },
  });
  // Shown once to the admin; never stored in plaintext.
  return json({ id, loginCode: code }, 201);
});

route("GET", "/api/users", "admin", () => {
  const users = getDb()
    .query(
      "SELECT id, email, name, role, created_at, disabled_at, (code_hash IS NOT NULL) AS has_code FROM users",
    )
    .all();
  return json({ users });
});

route("POST", "/api/users/:id/rotate-code", "admin", async (_req, admin, params) => {
  const db = getDb();
  const code = generateLoginCode();
  const res = db
    .query("UPDATE users SET code_hash = ?, code_rotated_at = ? WHERE id = ?")
    .run(await hashCode(code), nowIso(), params.id!);
  if (res.changes === 0) return json({ error: "user not found" }, 404);
  appendEvent(db, { actorUserId: admin!.id, entityType: "user", entityId: params.id!, eventType: "user.code_rotated" });
  return json({ loginCode: code });
});

route("POST", "/api/users/:id/revoke", "admin", (_req, admin, params) => {
  const db = getDb();
  revokeCode(db, params.id!);
  appendEvent(db, { actorUserId: admin!.id, entityType: "user", entityId: params.id!, eventType: "user.code_revoked" });
  return json({ ok: true });
});
