# Restoring Insights Engine from backup

Backups are produced by `scripts/backup.sh` (run it manually or nightly via cron / launchd). The backup root defaults to `~/Backups/insights-engine`:

```
~/Backups/insights-engine/
  db/insights-YYYYMMDD-HHMM.sqlite   point-in-time SQLite snapshots (30-day retention)
  blobs/                             accumulating mirror of data/blobs (never pruned)
```

## Restore the database

1. Stop the server (`Ctrl+C` on `bun run start`, or stop the service manager).
2. Pick a snapshot, newest first:

   ```sh
   ls -t ~/Backups/insights-engine/db/
   ```

3. Remove stale WAL sidecar files so SQLite does not replay an old write-ahead log over the restored snapshot:

   ```sh
   rm -i data/insights.sqlite-wal data/insights.sqlite-shm
   ```

   (`-i` prompts per file; both may legitimately not exist.)

4. Copy the snapshot into place:

   ```sh
   cp ~/Backups/insights-engine/db/insights-YYYYMMDD-HHMM.sqlite data/insights.sqlite
   ```

5. If the backup was taken with the `cp` fallback (no `sqlite3` CLI on the machine), there may be matching `-wal`/`-shm` files next to the snapshot. Copy them alongside so the snapshot set stays complete:

   ```sh
   cp ~/Backups/insights-engine/db/insights-YYYYMMDD-HHMM.sqlite-wal data/insights.sqlite-wal  # only if it exists
   ```

   Snapshots taken with `sqlite3 .backup` (the normal path) are single self-contained files; skip this step.

## Restore the blobs

```sh
rsync -a ~/Backups/insights-engine/blobs/ data/blobs/
```

Note: plain `rsync -a`, no `--delete`. The blob store is content-addressed (one directory per asset id), so restoring on top of existing blobs is safe and idempotent.

## Verify

1. Integrity check before starting the server:

   ```sh
   sqlite3 data/insights.sqlite "PRAGMA integrity_check;"   # expect: ok
   ```

2. Start the server and hit the health endpoint:

   ```sh
   bun run start
   curl http://localhost:4500/api/health
   ```

3. Spot-check: open a recent meeting in the UI and confirm its transcript and audio download work (proves db and blobs are from the same era).

## Point-in-time notes

- The db snapshot and the blob mirror are taken in the same run but are not a single atomic unit. A blob uploaded between the db snapshot and the rsync exists in `blobs/` but not in the db: harmless (orphan file). The reverse (db row without blob) can only happen if you restore a NEWER db with an OLDER blob mirror; prefer the newest blob mirror always, since blobs are never pruned.
- Purged meetings (retention, SPEC section 10) stay purged after a restore of a post-purge snapshot. Restoring a pre-purge snapshot resurrects the purged data; if the purge was a privacy obligation, re-run `DELETE /api/meetings/:id` after the restore.
