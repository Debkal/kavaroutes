#!/usr/bin/env bash
# First installation only. Run as root after uploading the reviewed bundle.
set -Eeuo pipefail
bundle=${1:?bundle required}
issuer=${2:?issuer required}
audience=${3:?audience required}
[[ $issuer =~ ^https://[a-z0-9-]+\.cloudflareaccess\.com$ ]]
[[ $audience =~ ^[a-f0-9]{64}$ ]]
[[ ! -e /opt/kavaroutes-admin && ! -e /var/lib/kavaroutes-admin ]]
image=$(docker inspect --format '{{.Image}}' kavaroutes-cloud-api-1)
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]]
docker run --rm --network none --entrypoint node "$image" -e 'if(Number(process.versions.node.split(".")[0])!==24)process.exit(1);require("node:crypto").generateKeyPairSync("ml-dsa-65");console.log("ADMIN_RUNTIME_CRYPTO_READY")'
if ! id kavaroutes-admin >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/kavaroutes-admin --shell /usr/sbin/nologin kavaroutes-admin
fi
admin_uid=$(id -u kavaroutes-admin)
admin_gid=$(id -g kavaroutes-admin)
install -d -m 755 /opt/kavaroutes-admin
tar --no-same-owner -xzf "$bundle" -C /opt/kavaroutes-admin
chown -R root:root /opt/kavaroutes-admin
chmod -R go-w /opt/kavaroutes-admin
install -d -o "$admin_uid" -g "$admin_gid" -m 700 /var/lib/kavaroutes-admin
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --user "$admin_uid:$admin_gid" \
  --mount type=bind,src=/opt/kavaroutes-admin,dst=/opt/kavaroutes-admin,readonly \
  --mount type=bind,src=/var/lib/kavaroutes-admin,dst=/var/lib/kavaroutes-admin \
  --workdir /opt/kavaroutes-admin --entrypoint node "$image" \
  apps/admin/bin/operator.mjs init --directory /var/lib/kavaroutes-admin --mode cloudflare --issuer "$issuer" --audience "$audience"
cat > /etc/systemd/system/kavaroutes-admin.service <<EOF
[Unit]
Description=KavaRoutes platform admin preview
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm --name kavaroutes-platform-admin --no-healthcheck --network host --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m --user $admin_uid:$admin_gid --mount type=bind,src=/opt/kavaroutes-admin,dst=/opt/kavaroutes-admin,readonly --mount type=bind,src=/var/lib/kavaroutes-admin,dst=/var/lib/kavaroutes-admin --workdir /opt/kavaroutes-admin --entrypoint node $image apps/admin/src/main.mjs /var/lib/kavaroutes-admin/config.json
ExecStop=/usr/bin/docker stop --time 15 kavaroutes-platform-admin
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
systemd-analyze verify /etc/systemd/system/kavaroutes-admin.service
systemctl daemon-reload
systemctl enable --now kavaroutes-admin.service
for attempt in $(seq 1 20); do
  if curl --fail --silent -H 'Host: admin.kavaroutes.com' http://127.0.0.1:58100/health/ready; then
    printf '\nADMIN_SERVICE_READY\n'
    exit 0
  fi
  sleep 1
done
systemctl stop kavaroutes-admin.service
printf 'ADMIN_SERVICE_HEALTH_FAILED\n' >&2
exit 1
