// Apply migrations/*.sql to DATABASE_URL (or POSTGRES_URL). Every file is
// idempotent, so running it again is safe. Used by `bun run db:migrate` and by
// the Vercel production build.
import { getDb, migrate } from "../src/db.ts";

if (process.env.VERCEL && process.env.VERCEL_ENV !== "production" && process.env.MIGRATE_ON_BUILD !== "1") {
  console.log(`db:migrate skipped for a ${process.env.VERCEL_ENV} build (set MIGRATE_ON_BUILD=1 to run it).`);
  process.exit(0);
}
const db = getDb();
await migrate(db);
console.log("migrations applied");
await db.close();
