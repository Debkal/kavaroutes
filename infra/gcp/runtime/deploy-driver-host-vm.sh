#!/usr/bin/env bash
set -Eeuo pipefail

stage=${1:?pass unpacked deployment directory}
web=/opt/kavaroutes/web
next=/opt/kavaroutes/web.driver-next
backup=/opt/kavaroutes/web.pre-driver-20260926
override=/opt/kavaroutes/runtime/prototype-compose.override.yaml
override_backup=${override}.pre-driver-20260926
admins=/opt/kavaroutes/secrets/driver-admins.json
changed=0

rollback(){
  local status=$?
  trap - ERR
  if [[ ${changed} -eq 1 ]]; then
    [[ -d ${web} ]] && mv "${web}" "${web}.failed-driver-20260926"
    [[ -d ${backup} ]] && mv "${backup}" "${web}"
    [[ -f ${override_backup} ]] && cp -a "${override_backup}" "${override}"
    systemctl restart kavaroutes-runtime.service || true
  fi
  exit "${status}"
}
trap rollback ERR

[[ -f ${stage}/apps/web/dist/index.html ]]
[[ -f ${stage}/apps/web/dist-driver/driver.html ]]
[[ -f ${stage}/infra/gcp/runtime/api.mjs ]]
[[ -f ${stage}/infra/gcp/runtime/driver-admin.mjs ]]
[[ -f ${stage}/infra/gcp/runtime/driver-gateway-policy.mjs ]]
[[ -f ${stage}/infra/gcp/runtime/prototype-web-gateway.mjs ]]
[[ -f ${stage}/infra/gcp/runtime/prototype-compose.override.yaml ]]
[[ -d ${web} && -f ${override} && ! -e ${next} && ! -e ${backup} ]]

install -d -o root -g root -m 0755 /opt/kavaroutes/secrets
if [[ ! -e ${admins} ]]; then
  printf '{"accounts":[]}\n' > "${admins}"
  chown root:1000 "${admins}"
  chmod 0640 "${admins}"
fi
if ! python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if any(a.get("loginId")=="test_pony_admin" for a in d.get("accounts",[])) else 1)' "${admins}"; then
  password=$(openssl rand -base64 24)
  printf '%s' "${password}" | python3 "${stage}/infra/gcp/runtime/provision-driver-admin.py" "${admins}" aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa test_pony_admin
  printf 'TEST_PONY_DRIVER_ADMIN_LOGIN test_pony_admin\nTEST_PONY_DRIVER_ADMIN_INITIAL_PASSWORD %s\n' "${password}"
fi

cp -a "${web}" "${next}"
cp -a "${stage}/apps/web/dist/." "${next}/dist/"
cp -a "${stage}/apps/web/dist-driver" "${next}/dist-driver"
install -m 0644 "${stage}/infra/gcp/runtime/api.mjs" "${next}/api.mjs"
install -m 0644 "${stage}/infra/gcp/runtime/driver-admin.mjs" "${next}/driver-admin.mjs"
install -m 0644 "${stage}/infra/gcp/runtime/provision-driver-admin.py" "${next}/provision-driver-admin.py"
install -m 0644 "${stage}/infra/gcp/runtime/driver-gateway-policy.mjs" "${next}/driver-gateway-policy.mjs"
install -m 0644 "${stage}/infra/gcp/runtime/prototype-web-gateway.mjs" "${next}/prototype-web-gateway.mjs"
cp -a "${override}" "${override_backup}"
install -m 0644 "${stage}/infra/gcp/runtime/prototype-compose.override.yaml" "${override}"
mv "${web}" "${backup}"
changed=1
mv "${next}" "${web}"
systemctl restart kavaroutes-runtime.service
curl --fail --silent --show-error --max-time 10 -H 'Host: driver.kavaroutes.com' http://127.0.0.1:58080/driver | grep -q 'KavaRoutes Driver'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -H 'Host: driver.kavaroutes.com' http://127.0.0.1:58080/dispatch)" = 404
test "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 -H 'Host: driver.kavaroutes.com' http://127.0.0.1:58080/v1/me)" = 404
changed=0
printf 'DRIVER_HOST_VM_DEPLOYED\n'
