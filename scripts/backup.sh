#!/usr/bin/env bash
#
# Followthrough database backup: a pg_dump of the Postgres database.
# Idempotent: safe to run repeatedly, safe to cron nightly.
#
#   DATABASE_URL    the database to dump. Use the direct (non-pooled) URL,
#                   e.g. Supabase's POSTGRES_URL_NON_POOLING.
#   BACKUP_DIR      destination root   (default ~/Backups/followthrough)
#   RETENTION_DAYS  dump age cap       (default 30)
#
# Produces $BACKUP_DIR/db/followthrough-YYYYMMDD-HHMM.dump (pg_dump custom
# format). Recordings and exports live in Supabase Storage (bucket
# "followthrough") and are not part of this dump. The only pruning is dumps
# older than RETENTION_DAYS inside $BACKUP_DIR/db; nothing else is removed.

set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the direct (non-pooled) Postgres URL}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/Backups/followthrough}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
command -v pg_dump >/dev/null || { echo "pg_dump not found (brew install libpq, or install the PostgreSQL client)" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M)"
DEST="$BACKUP_DIR/db/followthrough-$STAMP.dump"
mkdir -p "$BACKUP_DIR/db"

pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges --file="$DEST.tmp"
mv "$DEST.tmp" "$DEST"
echo "database: $DEST"

find "$BACKUP_DIR/db" -maxdepth 1 -name 'followthrough-*.dump' -mtime "+$RETENTION_DAYS" -print -delete
