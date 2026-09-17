"""VM-only rejected-configuration rollback drill; no image downgrade or migration reversal.

No digest is hardcoded. The accepted image is read from the live ``vm.env`` — the same file compose
and ``kavaroutes-runtime.service`` consume — and the drill refuses to start unless the running api
container already matches it, so a stale pin can neither pass silently nor block the drill. The
drill itself is unchanged: a deliberately rejected configuration must fail closed, the accepted
configuration is brought back, and the deterministic trip/schema evidence must be byte-identical.

Invocation: ``cloud-rollback.py`` (no arguments, root on the VM). Exit 0 only when the drill passed.
"""
import hashlib
import json
import pathlib
import re
import subprocess
import time

ROOT = pathlib.Path('/opt/kavaroutes/runtime')
REPOSITORY = 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime'
IMAGE_LINE = re.compile(r'^KR_RUNTIME_IMAGE=(' + re.escape(REPOSITORY) + r'@sha256:[0-9a-f]{64})$', re.M)
API = 'kavaroutes-cloud-api-1'
POSTGRES = 'kavaroutes-cloud-postgres-1'
REJECTED = ROOT / 'rollback-rejected.yaml'
SMOKE = ROOT / 'cloud-smoke.py'
BASE = ['docker', 'compose', '--env-file', str(ROOT / 'vm.env'), '-f', str(ROOT / 'compose.yaml')]
STACK = ['postgres', 'api', 'worker']


def run(args, timeout=150):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout).stdout


def accepted_image():
    match = IMAGE_LINE.search((ROOT / 'vm.env').read_text())
    if not match:
        raise ValueError('accepted configuration is not a pinned runtime image')
    return match.group(1)


def container_image():
    return run(['docker', 'inspect', '--format', '{{.Config.Image}}', API]).decode().strip()


def container_state():
    return json.loads(run(['docker', 'inspect', '--format', '{{json .State}}', API]))


def evidence():
    # Deterministic trip/schema evidence only; never return rows or credentials.
    sql = """SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY id),'')),count(*) FROM intake.trip_request t;
             SELECT md5(coalesce(string_agg(migration_name||sha256,',' ORDER BY migration_name),'')),count(*) FROM public.kavaroutes_schema_migration;"""
    return run(['docker', 'exec', POSTGRES, 'psql', '-U', 'kr_cloud_admin', '-d', 'kavaroutes_cloud', '-Atc', sql])


def logs():
    captured = subprocess.run(['docker', 'logs', API], check=True, capture_output=True, timeout=15)
    return captured.stdout, captured.stderr


def drill(image):
    before = evidence()
    run(BASE + ['-f', str(REJECTED), 'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', 'api'])
    state = {}
    for _ in range(20):
        state = container_state()
        if not state['Running']:
            break
        time.sleep(1)
    assert not state['Running'] and state['ExitCode'] == 1
    stdout, stderr = logs()
    assert stdout == b''  # the refusal is closed: nothing is written to stdout
    assert stderr.strip() == b'RUNTIME_START_FAILED'
    run(BASE + ['up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api'])
    assert evidence() == before
    assert container_image() == image
    run(['python3', str(SMOKE)])
    return before


def main():
    try:
        image = accepted_image()
        if container_image() != image:
            raise ValueError('source drift')
        if not REJECTED.is_file():
            raise ValueError('rejected configuration missing')
    except Exception:
        print('CLOUD_ROLLBACK_REQUIRES_REVIEW')
        return 1
    started, result = False, 1
    try:
        started = True
        before = drill(image)
        print(json.dumps({'result': 'CLOUD_CONFIG_ROLLBACK_PASSED', 'image': image,
                          'checks': ['bad-config-denied', 'closed-error-only', 'known-good-digest-restored',
                                     'trip-and-schema-digest-unchanged', 'business-flow-after-rollback'],
                          'evidenceSha256': hashlib.sha256(before).hexdigest()}))
        result = 0
    except Exception:
        print('CLOUD_CONFIG_ROLLBACK_FAILED')
    finally:
        if started:
            try:
                run(BASE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never'] + STACK)
            except Exception:
                print('CLOUD_ROLLBACK_RESTORE_FAILED')
                result = 1
    return result


if __name__ == '__main__':
    raise SystemExit(main())
