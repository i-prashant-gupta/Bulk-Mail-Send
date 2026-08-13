#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  Daily MySQL backup. Cron:
#    0 2 * * * /home/ubuntu/Email_Sender/scripts/backup-db.sh >> /home/ubuntu/backups/backup.log 2>&1
#  Optional S3:  export S3_BUCKET=s3://your-bucket/db-backups
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
set -a; [ -f .env ] && . ./.env; set +a

BACKUP_DIR="${BACKUP_DIR:-$HOME/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"
STAMP=$(date +%F_%H%M)
FILE="$BACKUP_DIR/${MYSQL_DATABASE:-mail_Sender}_$STAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

mysqldump \
  -h "${MYSQL_HOST:-127.0.0.1}" \
  -P "${MYSQL_PORT:-3306}" \
  -u "${MYSQL_USER:-root}" \
  -p"${MYSQL_PASSWORD}" \
  --single-transaction --routines --triggers \
  "${MYSQL_DATABASE:-mail_Sender}" | gzip > "$FILE"

echo "$(date) ✅ backup → $FILE ($(du -h "$FILE" | cut -f1))"

if [ -n "${S3_BUCKET:-}" ]; then
  aws s3 cp "$FILE" "$S3_BUCKET/" && echo "$(date) ☁️  uploaded to $S3_BUCKET"
fi

find "$BACKUP_DIR" -name "*.sql.gz" -mtime +"$RETAIN_DAYS" -delete
