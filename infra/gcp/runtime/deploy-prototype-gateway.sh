#!/usr/bin/env bash
set -Eeuo pipefail

stamp=20260916-prototype-web
api=/opt/kavaroutes/secrets/api.json
api_backup="${api}.pre-${stamp}"
web=/opt/kavaroutes/web
web_next=/opt/kavaroutes/web.next
web_backup="${web}.pre-${stamp}"
dropin_dir=/etc/systemd/system/kavaroutes-runtime.service.d
dropin="${dropin_dir}/prototype.conf"
dropin_backup="${dropin}.pre-${stamp}"
runtime=/opt/kavaroutes/runtime
staged=/tmp/kavaroutes-prototype-20260916
had_web=0
had_dropin=0
rollback_needed=0

rollback() {
  local status=$?
  trap - ERR
  if [[ ${rollback_needed} -eq 1 ]]; then
    systemctl stop kavaroutes-runtime.service || true
    [[ -e ${api} ]] && mv "${api}" "${api}.failed-${stamp}"
    cp -a "${api_backup}" "${api}"
    [[ -e ${dropin} ]] && mv "${dropin}" "${dropin}.failed-${stamp}"
    [[ ${had_dropin} -eq 1 ]] && mv "${dropin_backup}" "${dropin}"
    [[ -e ${web} ]] && mv "${web}" "${web}.failed-${stamp}"
    [[ ${had_web} -eq 1 ]] && mv "${web_backup}" "${web}"
    systemctl daemon-reload
    systemctl start kavaroutes-runtime.service || true
  fi
  exit "${status}"
}
trap rollback ERR

[[ $(jq -r '.port' "${api}") == 58080 ]]
[[ -f ${web_next}/dist/index.html && -f ${web_next}/prototype-web-gateway.mjs ]]
[[ ! -e ${api_backup} && ! -e ${web_backup} && ! -e ${dropin_backup} ]]
cp -a "${api}" "${api_backup}"
jq '.port = 58082' "${api}" > "${api}.next"
chown --reference="${api}" "${api}.next"
chmod --reference="${api}" "${api}.next"

if [[ -e ${web} ]]; then mv "${web}" "${web_backup}"; had_web=1; fi
install -d -o root -g root -m 755 "${dropin_dir}"
if [[ -e ${dropin} ]]; then mv "${dropin}" "${dropin_backup}"; had_dropin=1; fi
mv "${web_next}" "${web}"
install -o root -g root -m 644 "${staged}/kavaroutes-runtime-prototype.conf" "${dropin}"
mv "${api}.next" "${api}"
systemctl daemon-reload
rollback_needed=1
systemctl restart kavaroutes-runtime.service
curl --fail --silent --show-error http://127.0.0.1:58080/health/ready >/dev/null
curl --fail --silent --show-error http://127.0.0.1:58080/ | grep -q 'id="root"'
rollback_needed=0
printf 'PROTOTYPE_DEPLOYMENT_COMPLETE\n'
