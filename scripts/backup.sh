#!/usr/bin/env bash
#
# Followthrough backup (SPEC.md section 9).
# Idempotent: safe to run repeatedly, safe to cron nightly.
#
#   BACKUP_DIR  destination root      (default ~/Backups/followthrough)
#   DATA_DIR    source data dir       (default <repo>/data)
#   RETENTION_DAYS  db backup age cap (default 30)
#
# Layout produced:
#   $BACKUP_DIR/db/insights-YYYYMMDD-HHMM.sqlite   point-in-time snapshots
#   $BACKUP_DIR/blobs/                             rsync mirror of data/blobs
#
# Safety: rsync NEVER uses --delete (blob backups only accumulate), and the
# only pruning is timestamped db snapshots older than RETENTION_DAYS inside
# $BACKUP_DIR/db. Nothing outside $BACKUP_DIR is ever removed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

DATA_DIR="${DATA_DIR:-$REPO_ROOT/data}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/followthrough}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

DB_FILE="$DATA_DIR/insights.sqlite"
STAMP="$(date +%Y%m%d-%H%M)"
DB_DEST="$BACKUP_DIR/db/insights-$STAMP.sqlite"

mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/blobs"

# ---------------------------------------------------------------- database
if [ -f "$DB_FILE" ]; then
  if command -v sqlite3 >/dev/null 2>&1; then
    # .backup takes a consistent snapshot even while the server is writing (WAL)
    sqlite3 "$DB_FILE" ".backup '$DB_DEST'"
    echo "db: sqlite3 .backup -> $DB_DEST"
  else
    echo "db: sqlite3 CLI not found, falling back to cp (stop the server first for a guaranteed-consistent copy)"
    cp "$DB_FILE" "$DB_DEST"
    [ -f "$DB_FILE-wal" ] && cp "$DB_FILE-wal" "$DB_DEST-wal"
    [ -f "$DB_FILE-shm" ] && cp "$DB_FILE-shm" "$DB_DEST-shm"
    echo "db: cp -> $DB_DEST (plus -wal/-shm if present)"
  fi
else
  echo "db: no database at $DB_FILE, skipping"
fi

# ---------------------------------------------------------------- blobs
# -a preserves attrs; intentionally NO --delete so removing a blob locally
# never removes it from the backup.
if [ -d "$DATA_DIR/blobs" ]; then
  rsync -a "$DATA_DIR/blobs/" "$BACKUP_DIR/blobs/"
  echo "blobs: rsync -> $BACKUP_DIR/blobs/"
else
  echo "blobs: no blob dir at $DATA_DIR/blobs, skipping"
fi

# ---------------------------------------------------------------- prune
# Strictly scoped: timestamped snapshot files inside $BACKUP_DIR/db only.
PRUNED=$(find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'insights-*.sqlite*' -mtime +"$RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
echo "prune: removed $PRUNED db snapshot(s) older than $RETENTION_DAYS days"

# ---------------------------------------------------------------- summary
COUNT=$(find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'insights-*.sqlite' | wc -l | tr -d ' ')
echo ""
echo "Backup complete. $COUNT db snapshot(s) retained in $BACKUP_DIR/db"
echo ""
echo "To restore:"
echo "  1. Stop the server."
echo "  2. cp '$BACKUP_DIR/db/insights-<STAMP>.sqlite' '$DATA_DIR/insights.sqlite'"
echo "     (remove any stale $DATA_DIR/insights.sqlite-wal / -shm files first)"
echo "  3. rsync -a '$BACKUP_DIR/blobs/' '$DATA_DIR/blobs/'   # no --delete"
echo "  4. Start the server and check GET /api/health."
echo "Full instructions: scripts/RESTORE.md"
