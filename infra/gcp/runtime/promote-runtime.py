"""Existing VM only: backup, additive migration and pinned runtime promotion.

On failure preserve the failed database, restore the pre-promotion dump into the
original database name and restore the original image/configuration. No database
is dropped. Never print secret files, SQL data, or subprocess stderr.
"""
import json
import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path('/opt/kavaroutes/runtime')
BACKUP = pathlib.Path('/opt/kavaroutes/backups/sol009b-before.dump')
PREVIOUS = ROOT / 'vm.env.pre-sol009b'
BASE = ['docker', 'compose', '--env-file', str(ROOT / 'vm.env'), '-f', str(ROOT / 'compose.yaml')]
PG = ['docker', 'exec', '-i', 'kavaroutes-cloud-postgres-1']
OLD = 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime@sha256:115324ba9ee7723ddcc825e2e596d3af691d317887722730473dabb05ecf5d8b'

def run(args, data=None, timeout=180):
    return subprocess.run(args, input=data, capture_output=True, check=True, timeout=timeout).stdout

def main():
    if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'sha256:[0-9a-f]{64}', sys.argv[1]):
        raise ValueError('invalid invocation')
    target = 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime@' + sys.argv[1]
    env = (ROOT / 'vm.env').read_text()
    if 'KR_RUNTIME_IMAGE=' + OLD not in env or PREVIOUS.exists() or BACKUP.exists():
        raise ValueError('state requires review')
    for host in ['api', 'worker']:
        if run(['docker', 'inspect', '--format', '{{.Config.Image}}', 'kavaroutes-cloud-' + host + '-1']).decode().strip() != OLD:
            raise ValueError('source drift')
    run(['docker', 'image', 'inspect', target])  # Pull and verify separately before downtime.
    backup_dir = BACKUP.parent
    backup_dir.mkdir(mode=0o700, exist_ok=True)
    if backup_dir.is_symlink():
        raise ValueError('backup path invalid')
    PREVIOUS.write_text(env)
    os.chmod(PREVIOUS, 0o600)
    stopped = False
    migrated = False
    try:
        run(BASE + ['stop', 'api', 'worker'])
        stopped = True
        dump = run(PG + ['pg_dump', '-U', 'kr_cloud_admin', '-d', 'kavaroutes_cloud', '-Fc'])
        fd = os.open(BACKUP, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(dump)
        # Verify archive readability before any schema mutation.
        run(PG + ['pg_restore', '--list'], dump)
        (ROOT / 'vm.env').write_text(env.replace('KR_RUNTIME_IMAGE=' + OLD, 'KR_RUNTIME_IMAGE=' + target))
        migrated = True  # Initializer can fail after committing one additive migration.
        run(BASE + ['--profile', 'initialize', 'run', '--rm', '--no-deps', 'initialize'])
        run(BASE + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api', 'worker'])
        print(json.dumps({'result': 'SOL009B_RUNTIME_PROMOTED', 'image': target, 'backup': str(BACKUP)}))
    except Exception:
        if stopped:
            run(BASE + ['stop', 'api', 'worker'])
            if migrated:
                # Preserve post-attempt data; do not overwrite or destroy it.
                terminate = "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='kavaroutes_cloud' AND pid<>pg_backend_pid()"
                run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', terminate])
                run(PG + ['psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'ALTER DATABASE kavaroutes_cloud RENAME TO kavaroutes_sol009b_failed'])
                run(PG + ['createdb', '-U', 'kr_cloud_admin', 'kavaroutes_cloud'])
                run(PG + ['pg_restore', '-U', 'kr_cloud_admin', '-d', 'kavaroutes_cloud', '--exit-on-error'], BACKUP.read_bytes())
            (ROOT / 'vm.env').write_text(env)
            run(BASE + ['up', '-d', '--no-deps', '--wait', '--wait-timeout', '120', '--pull', 'never', 'api', 'worker'])
        print('SOL009B_PROMOTION_FAILED_PREVIOUS_RUNTIME_RESTORED')
        return 1
    return 0

if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('SOL009B_PROMOTION_REQUIRES_REVIEW')
        raise SystemExit(1)
