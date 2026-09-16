"""Bounded VM health telemetry. Never forward response bodies or exception text."""
import datetime
import json
import re
import urllib.request

PROJECT = 'kavaroutes'
METRIC = 'custom.googleapis.com/kavaroutes/runtime/ready'
EXPIRY = datetime.datetime(2026, 12, 7, 16, 22, tzinfo=datetime.timezone.utc)
SERVICES = {'api': 58080, 'worker': 58081}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def exchange(url, headers=None, body=None, limit=4096):
    request = urllib.request.Request(url, headers=headers or {}, data=body)
    with OPENER.open(request, timeout=5) as response:
        data = response.read(limit + 1)
        if len(data) > limit:
            raise ValueError('RESPONSE_LIMIT')
        return response.status, data


def ready(service):
    if service not in SERVICES:
        raise ValueError('SERVICE_DENIED')
    try:
        status, body = exchange(f'http://127.0.0.1:{SERVICES[service]}/health/ready', limit=128)
        expected = {'status': 'ready', 'profile': 'private-synthetic'} if service == 'api' else {'status': 'ready'}
        return status == 200 and json.loads(body) == expected
    except Exception:
        return False


def payloads(instance_id, states, timestamp):
    if not re.fullmatch(r'[0-9]{1,24}', instance_id) or set(states) != set(SERVICES):
        raise ValueError('TELEMETRY_SCOPE_DENIED')
    if any(type(value) is not bool for value in states.values()):
        raise ValueError('TELEMETRY_VALUE_DENIED')
    resource = {'type': 'gce_instance', 'labels': {
        'project_id': PROJECT, 'zone': 'us-west1-b', 'instance_id': instance_id}}
    metrics, logs = [], []
    for service, value in states.items():
        metrics.append({'metric': {'type': METRIC, 'labels': {'service': service}},
                        'resource': resource, 'metricKind': 'GAUGE', 'valueType': 'DOUBLE',
                        'points': [{'interval': {'endTime': timestamp}, 'value': {'doubleValue': int(value)}}]})
        logs.append({'severity': 'INFO' if value else 'ERROR', 'timestamp': timestamp,
                     'jsonPayload': {'service': service, 'code': 'RUNTIME_READY' if value else 'RUNTIME_UNAVAILABLE'}})
    return ({'timeSeries': metrics}, {'logName': f'projects/{PROJECT}/logs/kavaroutes-runtime-health',
                                    'resource': resource, 'entries': logs})


def main():
    now = datetime.datetime.now(datetime.timezone.utc)
    if now >= EXPIRY:
        print('TELEMETRY_WINDOW_EXPIRED')
        return 0
    try:
        metadata = 'http://metadata.google.internal/computeMetadata/v1/'
        headers = {'Metadata-Flavor': 'Google'}
        def meta(path):
            status, body = exchange(metadata + path, headers)
            if status != 200:
                raise ValueError('METADATA_FAILED')
            return body.decode()
        if meta('project/project-id') != PROJECT or meta('instance/name') != 'kavaroutes-dev-01':
            raise ValueError('WRONG_ENVIRONMENT')
        if not meta('instance/zone').endswith('/zones/us-west1-b'):
            raise ValueError('WRONG_ZONE')
        instance_id = meta('instance/id')
        token = json.loads(meta('instance/service-accounts/default/token'))['access_token']
        states = {service: ready(service) for service in SERVICES}
        stamp = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        metrics, logs = payloads(instance_id, states, stamp)
        auth = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}
        failed = False
        for url, payload in [
            (f'https://monitoring.googleapis.com/v3/projects/{PROJECT}/timeSeries', metrics),
            ('https://logging.googleapis.com/v2/entries:write', logs),
        ]:
            try:
                status, _ = exchange(url, auth, json.dumps(payload).encode())
                if status != 200:
                    failed = True
            except Exception:
                failed = True
        print('TELEMETRY_EXPORT_FAILED' if failed else 'TELEMETRY_EXPORTED')
        return 1 if failed else 0
    except Exception:
        print('TELEMETRY_EXPORT_FAILED')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
