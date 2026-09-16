"""VM-only rejected-configuration rollback; no image downgrade or migration reversal."""
import hashlib
import json
import subprocess
import time

BASE = ['docker', 'compose', '--env-file', '/opt/kavaroutes/runtime/vm.env', '-f', '/opt/kavaroutes/runtime/compose.yaml']
IMAGE = 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime@sha256:fd28e55ae370f68b261bec77dd0603b72157c8c86697b3b9c836f212602c5dec'


def run(args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=150).stdout


def evidence():
    # Deterministic trip/schema evidence only; never return rows or credentials.
    sql = """SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY id),'')),count(*) FROM intake.trip_request t;
             SELECT md5(coalesce(string_agg(migration_name||sha256,',' ORDER BY migration_name),'')),count(*) FROM public.kavaroutes_schema_migration;"""
    return run(['docker', 'exec', 'kavaroutes-cloud-postgres-1', 'psql', '-U', 'kr_cloud_admin', '-d', 'kavaroutes_cloud', '-Atc', sql])


def main():
    result = 1
    try:
        before = evidence()
        assert run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'kavaroutes-cloud-api-1']).decode().strip() == IMAGE
        run(BASE + ['-f', 'rollback-rejected.yaml', 'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'api'])
        for _ in range(20):
            state = json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', 'kavaroutes-cloud-api-1']))
            if not state['Running']:
                break
            time.sleep(1)
        assert not state['Running'] and state['ExitCode'] == 1
        assert run(['docker', 'logs', 'kavaroutes-cloud-api-1']) == b''  # closed failure is on stderr, inspected separately below
        captured = subprocess.run(['docker', 'logs', 'kavaroutes-cloud-api-1'], check=True, capture_output=True, timeout=15)
        assert captured.stderr.strip() == b'RUNTIME_START_FAILED'
        run(BASE + ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api'])
        assert evidence() == before
        assert run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'kavaroutes-cloud-api-1']).decode().strip() == IMAGE
        run(['python3', 'cloud-smoke.py'])
        print(json.dumps({'result': 'CLOUD_CONFIG_ROLLBACK_PASSED',
                          'checks': ['bad-config-denied', 'closed-error-only', 'known-good-digest-restored', 'trip-and-schema-digest-unchanged', 'business-flow-after-rollback'],
                          'evidenceSha256': hashlib.sha256(before).hexdigest()}))
        result = 0
    except Exception:
        print('CLOUD_CONFIG_ROLLBACK_FAILED')
    finally:
        try:
            run(BASE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', 'postgres', 'api', 'worker'])
        except Exception:
            print('CLOUD_ROLLBACK_RESTORE_FAILED')
            result = 1
    return result


if __name__ == '__main__':
    raise SystemExit(main())
