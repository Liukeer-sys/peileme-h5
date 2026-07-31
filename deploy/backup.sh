#!/bin/sh
set -eu

COMPOSE_DIR="/opt/1panel/docker/compose/peileme"
BACKUP_ROOT="/opt/1panel/backup/peileme"
POSTGRES_VOLUME="/var/lib/docker/volumes/peileme_peileme_postgres/_data"
UPLOAD_VOLUME="/var/lib/docker/volumes/peileme_peileme_uploads/_data"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_DIR="${BACKUP_ROOT}/${STAMP}"
LOCK_FILE="/var/lock/peileme-backup.lock"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

(
  flock -n 9 || {
    echo "A Peileme backup is already running"
    exit 1
  }

  cd "$COMPOSE_DIR"
  POSTGRES_USER="$(sed -n 's/^POSTGRES_USER=//p' .env)"
  POSTGRES_DB="$(sed -n 's/^POSTGRES_DB=//p' .env)"
  TEMP_DIR="$(mktemp -d "${BACKUP_ROOT}/.${STAMP}.XXXXXX")"
  trap 'rm -rf "$TEMP_DIR"' EXIT

  docker exec peileme-db pg_dump \
    --clean \
    --if-exists \
    --no-owner \
    --no-privileges \
    -U "$POSTGRES_USER" \
    "$POSTGRES_DB" | gzip -9 > "${TEMP_DIR}/database.sql.gz"

  tar -C "$UPLOAD_VOLUME" -czf "${TEMP_DIR}/uploads.tar.gz" .
  install -m 600 .env "${TEMP_DIR}/production.env"
  {
    printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'deployed_commit=%s\n' "$(cat .deployed-commit 2>/dev/null || printf unknown)"
    printf 'postgres_volume=%s\n' "$POSTGRES_VOLUME"
    printf 'upload_volume=%s\n' "$UPLOAD_VOLUME"
  } > "${TEMP_DIR}/manifest.txt"
  chmod 600 "${TEMP_DIR}"/*

  mv "$TEMP_DIR" "$FINAL_DIR"
  trap - EXIT
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +13 -exec rm -rf -- {} +
  echo "Peileme backup completed: $FINAL_DIR"
) 9>"$LOCK_FILE"
