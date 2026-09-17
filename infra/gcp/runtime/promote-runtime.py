"""Existing VM only: parameterised backup, additive migration and pinned runtime promotion.

Invocation: ``promote-runtime.py <sha256:digest> [label]``.

The previous image is read from the live ``vm.env`` instead of being hardcoded, and
every artifact name is derived from ``label`` (default: the target digest's first 12
hex characters), so one reviewed script serves every promotion and can never
overwrite an earlier backup, previous-config file or failed database. A promotion
whose target already equals the running image, whose artifacts already exist, or
whose live containers have drifted from ``vm.env`` is refused before anything is
stopped.

On failure the failed database is preserved under its own name, the pre-promotion
dump is restored into the original database name and the original
image/configuration is brought back. No database is dropped. Never print secret
files, SQL data, or subprocess stderr.
"""
import json
import os
import pathlib
import re
import subprocess
import sys
import time

ROOT = pathlib.Path('/opt/kavaroutes/runtime')
BACKUP_DIR = pathlib.Path('/opt/kavaroutes/backups')
REPOSITORY = 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime'
DATABASE = 'kavaroutes_cloud'
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')
LABEL = re.compile(r'[a-z0-9][a-z0-9-]{2,31}')
PG = ['docker', 'exec', '-i', 'kavaroutes-cloud-postgres-1']


def run(args, data=None, timeout=180):
    return subprocess.run(args, input=data, capture_output=True, check=True, timeout=timeout).stdout


def container_state(host):
    container = 'kavaroutes-cloud-' + host + '-1'
    try:
        return run(['docker', 'inspect', '--format',
            '{{if .State.Health}}{{.State.Health.Status}}{{else}}RUNNING{{end}}', container]).decode().strip()
    except subprocess.CalledProcessError:
        return 'UNKNOWN'


def main():
    if os.geteuid() != 0 or len(sys.argv) not in (2, 3) or not DIGEST.fullmatch(sys.argv[1]):
        raise ValueError('invalid invocation')
    target = REPOSITORY + '@' + sys.argv[1]
    label = sys.argv[2] if len(sys.argv) == 3 else sys.argv[1].split(':')[1][:12]
    if not LABEL.fullmatch(label):
        raise ValueError('invalid invocation')
    previous_config = ROOT / ('vm.env.pre-' + label)
    backup = BACKUP_DIR / (label + '-before.dump')
    failed_database = DATABASE + '_' + label + '_failed'
    base = ['docker', 'compose', '--env-file', str(ROOT / 'vm.env'), '-f', str(ROOT / 'compose.yaml')]
    env = (ROOT / 'vm.env').read_text()
    match = re.search(r'^KR_RUNTIME_IMAGE=(' + re.escape(REPOSITORY) + r'@sha256:[0-9a-f]{64})$', env, re.M)
    if not match or match.group(1) == target or previous_config.exists() or backup.exists():
        raise ValueError('state requires review')
    old = match.group(1)
    taken = run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-Atc',
        "SELECT count(*) FROM pg_database WHERE datname IN ('" + failed_database + "')"]).decode().strip()
    if taken != '0':
        raise ValueError('state requires review')
    for host in ['api', 'worker']:
        if run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'kavaroutes-cloud-' + host + '-1']).decode().strip() != old:
            raise ValueError('source drift')
    run(['docker', 'image', 'inspect', target])  # Pull and verify separately before downtime.
    BACKUP_DIR.mkdir(mode=0o700, exist_ok=True)
    if BACKUP_DIR.is_symlink():
        raise ValueError('backup path invalid')
    previous_config.write_text(env)
    os.chmod(previous_config, 0o600)
    stopped = False
    migrated = False
    try:
        run(base + ['stop', 'api', 'worker'])
        stopped = True
        dump = run(PG + ['pg_dump', '-U', 'kr_cloud_admin', '-d', DATABASE, '-Fc'])
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(dump)
        # Verify archive readability before any schema mutation.
        run(PG + ['pg_restore', '--list'], dump)
        (ROOT / 'vm.env').write_text(env.replace('KR_RUNTIME_IMAGE=' + old, 'KR_RUNTIME_IMAGE=' + target))
        migrated = True  # Initializer can fail after committing one additive migration.
        run(base + ['--profile', 'initialize', 'run', '--rm', '--no-deps', 'initialize'])
        run(base + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api', 'worker'])
        for host in ['api', 'worker']:
            if run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'kavaroutes-cloud-' + host + '-1']).decode().strip() != target:
                raise ValueError('promoted image mismatch')
        healthy = False
        for _ in range(30):
            if set(container_state(host) for host in ['api', 'worker']) <= {'healthy', 'RUNNING'}:
                healthy = True
                break
            time.sleep(2)
        if not healthy:
            raise ValueError('promoted containers are not healthy')
        schema = run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', DATABASE, '-Atc',
            'SELECT max(migration_name) FROM public.kavaroutes_schema_migration']).decode().strip()
        print(json.dumps({'result': 'RUNTIME_PROMOTED', 'label': label, 'image': target, 'previousImage': old,
            'rollbackImage': old, 'backup': str(backup), 'previousConfig': str(previous_config), 'schema': schema}))
    except Exception:
        if stopped:
            run(base + ['stop', 'api', 'worker'])
            if migrated:
                # Preserve post-attempt data; do not overwrite or destroy it.
                terminate = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='" + DATABASE + "' AND pid<>pg_backend_pid()"
                run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', terminate])
                run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                    'ALTER DATABASE ' + DATABASE + ' RENAME TO ' + failed_database])
                run(PG + ['createdb', '-U', 'kr_cloud_admin', DATABASE])
                run(PG + ['pg_restore', '-U', 'kr_cloud_admin', '-d', DATABASE, '--exit-on-error'], backup.read_bytes())
            (ROOT / 'vm.env').write_text(env)
            run(base + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api', 'worker'])
        print('PROMOTION_FAILED_PREVIOUS_RUNTIME_RESTORED')
        return 1
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('PROMOTION_REQUIRES_REVIEW')
        raise SystemExit(1)
