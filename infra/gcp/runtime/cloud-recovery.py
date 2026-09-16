"""VM-only synthetic durable-trip and cursor recovery across real host restarts."""
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

COMPOSE = ['docker', 'compose', '--env-file', '/opt/kavaroutes/runtime/vm.env',
           '-f', '/opt/kavaroutes/runtime/compose.yaml']
TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
TRIP = str(uuid.uuid4())
KEY = str(uuid.uuid4())
SCOPE = {'streamKind': 'DISPATCH_DAY', 'scopeReference': f'branch:{TENANT}', 'serviceDate': '2026-09-12'}
PAYLOAD = {'tripId': TRIP, 'riderId': '11111111-1111-4111-8111-111111111112',
           'serviceDate': '2026-09-12', 'serviceTimezone': 'America/Los_Angeles',
           'localServiceTime': '08:00:00', 'resolvedServiceAt': '2026-09-12T15:00:00.000Z',
           'resolvedUtcOffsetSeconds': -25200, 'ambiguityPolicy': 'reject'}


def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=150).stdout


def request(suffix, data=None):
    headers = {'Authorization': 'Synthetic principal_dispatcher', 'Content-Type': 'application/json', 'Idempotency-Key': KEY}
    req = urllib.request.Request(f'http://127.0.0.1:58080/v1/organizations/{TENANT}/{suffix}',
                                 headers=headers, data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req, timeout=10) as response:
        return response.status, json.loads(response.read(1048576))


def count(table):
    allowed = {'intake.trip_request': 'id', 'outbox.consumer_projection': 'aggregate_id'}
    field = allowed[table]
    sql = f"SELECT count(*) FROM {table} WHERE tenant_id='{TENANT}' AND {field}='{TRIP}'"
    return int(run(['docker', 'exec', 'kavaroutes-cloud-postgres-1', 'psql', '-U', 'kr_cloud_admin',
                    '-d', 'kavaroutes_cloud', '-Atc', sql]))


def replay(cursor):
    status, body = request('realtime-change-queries', {'purpose': 'DISPATCH_CONTROL', 'scope': SCOPE, 'cursor': cursor, 'limit': 100})
    return status == 200 and any(c['delta']['resourceReference'] == f'trip:{TRIP}' for c in body['changes'])


def main():
    result = 1
    try:
        status, snapshot = request('runtime-dispatch-snapshot?serviceDate=2026-09-12')
        assert status == 200
        run(COMPOSE + ['stop', '--timeout', '20', 'worker'])
        first = request('trips', PAYLOAD)
        assert first[0] == 201 and count('intake.trip_request') == 1
        assert count('outbox.consumer_projection') == 0
        run(COMPOSE + ['restart', 'api'])
        run(COMPOSE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api'])
        assert request('trips', PAYLOAD) == first
        run(COMPOSE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'worker'])
        for _ in range(60):
            if count('outbox.consumer_projection') > 0 and replay(snapshot['cursor']):
                break
            time.sleep(1)
        else:
            raise ValueError('RECOVERY_TIMEOUT')
        effects = count('outbox.consumer_projection')
        run(COMPOSE + ['restart', 'api', 'worker'])
        run(COMPOSE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api', 'worker'])
        assert request('trips', PAYLOAD) == first
        assert replay(snapshot['cursor'])
        assert count('intake.trip_request') == 1 and count('outbox.consumer_projection') == effects
        print(json.dumps({'result': 'CLOUD_DURABLE_RESTART_REPLAY_PASSED',
                          'checks': ['commit-while-worker-offline', 'no-premature-projection', 'idempotency-after-api-restart',
                                     'worker-backlog-drained', 'old-cursor-replay-after-two-restarts', 'stable-effect-count'],
                          'projectionCount': effects}))
        result = 0
    except Exception:
        print('CLOUD_DURABLE_RESTART_REPLAY_FAILED')
    finally:
        try:
            run(COMPOSE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'postgres', 'api', 'worker'])
        except Exception:
            print('CLOUD_RECOVERY_RESTORE_FAILED')
            result = 1
    return result


if __name__ == '__main__':
    raise SystemExit(main())
