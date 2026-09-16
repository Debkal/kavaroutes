#!/usr/bin/env bash
set -euo pipefail

# CLD-009 Debian 12 VM preparation. Run through IAP as an OS Login user.
# This script installs only the host container prerequisites; it never creates
# credentials, enables public listeners, or writes application secret values.

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ROOT_REQUIRED" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl python3
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --max-time 30 https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
install -m 0644 "$(dirname "$0")/docker.sources" /etc/apt/sources.list.d/docker.sources
apt-get update
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-compose-plugin
systemctl enable --now docker

install -d -o root -g root -m 0750 /opt/kavaroutes
install -d -o root -g root -m 0700 /opt/kavaroutes/secrets
install -d -o root -g root -m 0750 /opt/kavaroutes/runtime

docker version --format '{{.Server.Version}}'
docker compose version
printf '%s\n' 'VM_RUNTIME_PREREQUISITES_READY'
