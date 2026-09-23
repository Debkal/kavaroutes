#!/usr/bin/env bash
# Run as root on the existing admin VM after uploading the reviewed source bundle.
set -Eeuo pipefail
bundle=${1:?bundle required}
backup=/var/lib/kavaroutes-admin/accounting-backup-20260922
[[ ! -e "$backup" ]]
install -d -m 700 "$backup"
# Stop only admin to checkpoint/close SQLite and copy a consistent private backup.
systemctl stop kavaroutes-admin.service
trap 'systemctl start kavaroutes-admin.service' EXIT
cp -a /var/lib/kavaroutes-admin/config.json "$backup/"
find /var/lib/kavaroutes-admin -maxdepth 1 -type f ! -name config.json -exec cp -a -t "$backup" {} +
tar -czf "$backup/source.tar.gz" -C /opt/kavaroutes-admin apps/admin/src apps/admin/public
# Bundle contains only reviewed admin source/static files, not configuration or data.
tar --no-same-owner -xzf "$bundle" -C /opt/kavaroutes-admin
chown -R root:root /opt/kavaroutes-admin/apps/admin/src /opt/kavaroutes-admin/apps/admin/public
chmod -R go-w /opt/kavaroutes-admin/apps/admin/src /opt/kavaroutes-admin/apps/admin/public
systemctl start kavaroutes-admin.service
for attempt in $(seq 1 20); do
  if curl --fail --silent -H 'Host: admin.kavaroutes.com' http://127.0.0.1:58100/health/ready; then
    printf '\nADMIN_ACCOUNTING_READY\n'
    trap - EXIT
    exit 0
  fi
  sleep 1
done
# Additive schema is backward-compatible; restore old code on failed health check.
systemctl stop kavaroutes-admin.service
tar -xzf "$backup/source.tar.gz" -C /opt/kavaroutes-admin
printf 'ADMIN_ACCOUNTING_HEALTH_FAILED_SOURCE_ROLLED_BACK\n' >&2
exit 1
