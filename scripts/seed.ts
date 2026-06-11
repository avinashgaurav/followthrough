// One-time bootstrap: creates the admin user and prints their login code.
// Usage: bun run scripts/seed.ts [email] [name]
import { getDb, nowIso } from "../src/db.ts";
import { ulid } from "../src/ids.ts";
import { generateLoginCode, hashCode } from "../src/auth.ts";
import { appendEvent } from "../src/events.ts";

const email = (process.argv[2] ?? "admin@xyz.com").toLowerCase();
const name = process.argv[3] ?? "Avinash Gaurav";

const db = getDb();
const existing = db.query("SELECT id FROM users WHERE email = ?").get(email);
if (existing) {
  console.log(`User ${email} already exists. Use the rotate-code endpoint to get a new code.`);
  process.exit(0);
}

const id = ulid();
const code = generateLoginCode();
db.query(
  "INSERT INTO users (id, email, name, role, code_hash, created_at) VALUES (?, ?, ?, 'admin', ?, ?)",
).run(id, email, name, await hashCode(code), nowIso());
appendEvent(db, {
  actorUserId: null,
  entityType: "user",
  entityId: id,
  eventType: "user.created",
  payload: { email, role: "admin", seeded: true },
});

console.log(`Admin created: ${name} <${email}>`);
console.log(`Login code (shown once, store it safely): ${code}`);
