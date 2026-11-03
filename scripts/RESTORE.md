# Restoring Followthrough from backup

`scripts/backup.sh` writes `pg_dump` snapshots of the Postgres database to `~/Backups/followthrough/db/followthrough-YYYYMMDD-HHMM.dump` (30-day retention). Recordings and CSV exports live in Supabase Storage (bucket `followthrough`) and are not in the dump.

## Restore the database

1. Pick a dump, newest first: `ls -t ~/Backups/followthrough/db/`
2. Restore into an **empty** database (a new Supabase project, or a fresh local Postgres). Use the direct (non-pooled) URL:

   ```sh
   pg_restore --no-owner --no-privileges --dbname="$DATABASE_URL" ~/Backups/followthrough/db/followthrough-YYYYMMDD-HHMM.dump
   ```

3. Point the app at it (`DATABASE_URL` / `POSTGRES_URL`) and redeploy. `bun run db:migrate` is safe to run afterwards: every migration is idempotent.

The `events` table is append-only (a trigger refuses updates and deletes), so never try to "fix" history in place; restore a dump instead.
