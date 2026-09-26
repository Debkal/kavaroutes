#!/usr/bin/env bash
# Run as root on the existing admin VM after uploading the reviewed source bundle.
set -Eeuo pipefail
bundle=${1:?bundle required}
[[ -f "$bundle" ]]
root=/opt/kavaroutes-admin
backup=$(mktemp -d /var/lib/kavaroutes-admin/manual-charge-backup-XXXXXXXX)
chmod 700 "$backup"
paths=(
  apps/admin/src/manual-charge-events.mjs
  apps/admin/src/store.mjs
  apps/admin/src/server.mjs
  apps/admin/public/index.html
  apps/admin/public/app.js
  apps/admin/bin/seed-test-pony-2026-09-25.mjs
)
expected=$(printf '%s\n' "${paths[@]}" | sort)
actual=$(tar -tzf "$bundle" | sort)
[[ "$expected" == "$actual" ]]

rollback=0
stopped=0
restore() {
  local status=$?
  trap - ERR
  if [[ "$stopped" -eq 1 ]]; then
    systemctl stop kavaroutes-admin.service || true
    if [[ "$rollback" -eq 1 ]]; then tar -xzf "$backup/source.tar.gz" -C "$root"; fi
    systemctl start kavaroutes-admin.service || true
  fi
  exit "$status"
}
trap restore ERR

systemctl stop kavaroutes-admin.service
stopped=1
tar -czf "$backup/source.tar.gz" -C "$root" apps/admin/src apps/admin/public apps/admin/bin
cp -a /var/lib/kavaroutes-admin/admin.sqlite "$backup/admin.sqlite"
rollback=1
tar --no-same-owner -xzf "$bundle" -C "$root"
chown -R root:root "$root/apps/admin/src" "$root/apps/admin/public" "$root/apps/admin/bin"
chmod -R go-w "$root/apps/admin/src" "$root/apps/admin/public" "$root/apps/admin/bin"
systemctl start kavaroutes-admin.service
for attempt in $(seq 1 20); do
  if curl --fail --silent --show-error -H 'Host: admin.kavaroutes.com' http://127.0.0.1:58100/health/ready >/dev/null; then
    printf 'ADMIN_MANUAL_ROUTE_CHARGES_READY\n'
    rollback=0
    stopped=0
    trap - ERR
    exit 0
  fi
  sleep 1
done
false
