#!/usr/bin/env bash
set -Eeuo pipefail
bundle=${1:?bundle required}
[[ ! -e /opt/kavaroutes-site && ! -e /var/lib/kavaroutes-site ]]
image=$(docker inspect --format '{{.Image}}' kavaroutes-cloud-api-1)
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]]
docker run --rm --network none --entrypoint node "$image" --input-type=module -e 'import "fastify";import "firebase-admin/auth";import "node:sqlite";if(Number(process.versions.node.split(".")[0])!==24)process.exit(1);console.log("SITE_RUNTIME_READY")'
if ! id kavaroutes-site >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/kavaroutes-site --shell /usr/sbin/nologin kavaroutes-site
fi
site_uid=$(id -u kavaroutes-site)
site_gid=$(id -g kavaroutes-site)
install -d -m 755 /opt/kavaroutes-site
tar --no-same-owner -xzf "$bundle" -C /opt/kavaroutes-site
chown -R root:root /opt/kavaroutes-site
chmod -R go-w /opt/kavaroutes-site
install -d -m 700 -o "$site_uid" -g "$site_gid" /var/lib/kavaroutes-site
cat > /etc/kavaroutes-site.env <<'ENV'
KR_SITE_ORIGIN=https://kavaroutes.com
KR_SITE_PORT=58110
KR_SITE_DATABASE=/var/lib/kavaroutes-site/accounts.sqlite
KR_SITE_FIREBASE_PROJECT_ID=kavaroutes
ENV
chmod 600 /etc/kavaroutes-site.env
cat > /etc/systemd/system/kavaroutes-site.service <<EOF
[Unit]
Description=KavaRoutes public business homepage
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/docker run --rm --name kavaroutes-public-site --no-healthcheck --network host --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m --user $site_uid:$site_gid --env-file /etc/kavaroutes-site.env --mount type=bind,src=/opt/kavaroutes-site,dst=/app/apps/site,readonly --mount type=bind,src=/var/lib/kavaroutes-site,dst=/var/lib/kavaroutes-site --workdir /app/apps/site --entrypoint node $image server/main.mjs
ExecStop=/usr/bin/docker stop --time 15 kavaroutes-public-site
Restart=on-failure
RestartSec=5
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
systemd-analyze verify /etc/systemd/system/kavaroutes-site.service
systemctl daemon-reload
systemctl enable --now kavaroutes-site.service
for attempt in $(seq 1 20); do
  if curl --fail --silent http://127.0.0.1:58110/health/ready; then
    printf '\nSITE_SERVICE_READY\n'
    exit 0
  fi
  sleep 1
done
systemctl stop kavaroutes-site.service
printf 'SITE_SERVICE_HEALTH_FAILED\n' >&2
exit 1
