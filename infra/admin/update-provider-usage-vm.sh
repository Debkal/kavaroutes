#!/usr/bin/env bash
# Existing VM only. Installs the reviewed admin source bundle with a rollback copy.
set -Eeuo pipefail
bundle=${1:?bundle required}
label=${2:?label required}
[[ $label =~ ^[a-z0-9][a-z0-9-]{2,31}$ ]]
backup="/var/lib/kavaroutes-admin/provider-usage-backup-$label"
[[ -f "$bundle" && ! -e "$backup" ]]
install -d -m 700 "$backup"
systemctl stop kavaroutes-admin.service
cp -a /var/lib/kavaroutes-admin/config.json "$backup/"
find /var/lib/kavaroutes-admin -maxdepth 1 -type f ! -name config.json -exec cp -a -t "$backup" {} +
tar -czf "$backup/source.tar.gz" -C /opt/kavaroutes-admin apps/admin/src apps/admin/public
restore(){
  systemctl stop kavaroutes-admin.service || true
  tar -xzf "$backup/source.tar.gz" -C /opt/kavaroutes-admin
  systemctl start kavaroutes-admin.service || true
  printf 'ADMIN_PROVIDER_USAGE_ROLLED_BACK\n' >&2
}
trap restore ERR
tar --no-same-owner -xzf "$bundle" -C /opt/kavaroutes-admin
chown -R root:root /opt/kavaroutes-admin/apps/admin/src /opt/kavaroutes-admin/apps/admin/public
chmod -R go-w /opt/kavaroutes-admin/apps/admin/src /opt/kavaroutes-admin/apps/admin/public
systemctl start kavaroutes-admin.service
ready=0
for attempt in $(seq 1 20); do
  if curl --fail --silent -H 'Host: admin.kavaroutes.com' http://127.0.0.1:58100/health/ready >/dev/null; then ready=1;break;fi
  sleep 1
done
[[ $ready == 1 ]]
trap - ERR
printf 'ADMIN_PROVIDER_USAGE_READY\n'
