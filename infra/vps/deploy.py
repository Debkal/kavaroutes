"""Promote an already provisioned VPS using verified images, backups and rollback.

Run as root on the protected deployment runner. No builds or package downloads
occur on the host. A fresh host must be initialized using the documented commands.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import sys
import uuid
from release import APPS, image_fingerprint, run, verify

HOSTS = ('api', 'worker', 'gateway', 'site', 'admin')
IMAGE_APP = {'api': 'runtime', 'worker': 'runtime', 'gateway': 'gateway',
             'site': 'site', 'admin': 'admin'}
STATE_KEYS = ('KR_DRIVER_ACCESS_DIRECTORY', 'KR_SITE_DIRECTORY',
              'KR_REGISTRATIONS_DIRECTORY', 'KR_ADMIN_DIRECTORY')


def read_environment(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('VPS_ENVIRONMENT_REQUIRES_PRIVATE_REGULAR_FILE')
    text = path.read_text()
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, separator, value = line.partition('=')
        if not separator or not re.fullmatch(r'KR_[A-Z_]+', key) or key in values or '$' in value:
            raise ValueError('VPS_ENVIRONMENT_INVALID')
        values[key] = value.strip().strip('\"\'')
    return text, values


def atomic_private(path, content):
    temporary = path.with_name(path.name + '.next-' + uuid.uuid4().hex)
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(content)
    os.replace(temporary, path)


def stream_command(args, *, input_path=None, output_path=None):
    import subprocess
    with open(input_path, 'rb') if input_path else open(os.devnull, 'rb') as source:
        with open(output_path, 'xb') if output_path else open(os.devnull, 'wb') as target:
            if output_path:
                os.chmod(output_path, 0o600)
            try:
                subprocess.run(args, stdin=source, stdout=target, stderr=subprocess.PIPE,
                               check=True, timeout=900)
            except subprocess.SubprocessError:
                raise RuntimeError('VPS_DATABASE_STREAM_FAILED') from None


def copy_state(source, target):
    # A stopped writer makes WAL/SHM copies consistent. Preserve each file's
    # owner as well as mode, so restored SQLite and Driver secrets stay readable.
    shutil.copytree(source, target, symlinks=True)
    for path in (target, *target.rglob('*')):
        relative = path.relative_to(target)
        metadata = (source / relative).lstat()
        os.chown(path, metadata.st_uid, metadata.st_gid, follow_symlinks=False)


def preflight(environment):
    for key in (*STATE_KEYS, 'KR_SECRETS_DIRECTORY', 'KR_GOOGLE_DIRECTORY'):
        path = Path(environment.get(key, ''))
        if not path.is_absolute() or path.is_symlink() or not path.is_dir():
            raise ValueError('VPS_PRIVATE_DIRECTORY_REQUIRED')
    directories = [Path(environment[key]).resolve() for key in STATE_KEYS]
    if any(a == b or a in b.parents or b in a.parents
           for i, a in enumerate(directories) for b in directories[i + 1:]):
        raise ValueError('VPS_STATE_DIRECTORIES_MUST_NOT_OVERLAP')
    access = Path(environment['KR_DRIVER_ACCESS_DIRECTORY']) / 'access.json'
    if access.is_symlink() or not access.is_file() or access.stat().st_mode & 0o007:
        raise ValueError('VPS_DRIVER_ACCESS_STATE_REQUIRED')
    state = json.loads(access.read_text())
    if state.get('version') != 1 or not all(isinstance(state.get(key), list)
            for key in ('codes', 'devices', 'events', 'driverTokens')):
        raise ValueError('VPS_DRIVER_ACCESS_STATE_INVALID')
    secrets = Path(environment['KR_SECRETS_DIRECTORY'])
    for role, port in (('admin', None), ('api', 58082), ('worker', 58081)):
        path = secrets / (role + '.json')
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError('VPS_RUNTIME_CONFIG_REQUIRES_PRIVATE_FILE')
        config = json.loads(path.read_text())
        if config.get('profile') != 'business-authenticated' or (port and config.get('port') != port):
            raise ValueError('VPS_PRODUCTION_PROFILE_AND_PORT_REQUIRED')
    path = Path(environment['KR_ADMIN_DIRECTORY']) / 'config.json'
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError('VPS_ADMIN_CONFIG_REQUIRES_PRIVATE_FILE')
    config = json.loads(path.read_text())
    if (config.get('mode') != 'cloudflare' or config.get('port') != 58100
            or config.get('database') != '/var/lib/kavaroutes-admin/admin.sqlite'):
        raise ValueError('VPS_ADMIN_PRODUCTION_CONFIG_REQUIRED')


def deploy(artifact, source_commit, env_file, release_root):
    if os.geteuid() != 0:
        raise ValueError('VPS_DEPLOY_ROOT_REQUIRED')
    artifact, env_file, release_root = map(lambda value: Path(value).absolute(),
                                         (artifact, env_file, release_root))
    if release_root.is_symlink():
        raise ValueError('VPS_RELEASE_DIRECTORY_INVALID')
    manifest = verify(artifact, source_commit)
    original, environment = read_environment(env_file)
    preflight(environment)
    release_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (release_root / 'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = release_root / 'current'
        previous_compose = current.resolve() / 'compose.vps.yml'
        if (not current.is_symlink() or not current.resolve().is_relative_to(release_root.resolve())
                or not previous_compose.is_file()):
            raise ValueError('VPS_INITIAL_DEPLOYMENT_REQUIRED')
        release = release_root / manifest['buildId']
        if release.exists() or environment.get('KR_BUILD_ID') == manifest['buildId']:
            raise ValueError('VPS_RELEASE_ALREADY_PRESENT')

        def compose(path, args):
            return run(['docker', 'compose', '-p', 'kavaroutes-vps', '--env-file', str(env_file),
                        '-f', str(path), '--profile', 'admin', *args])

        def previous(args):
            return compose(previous_compose, args)

        previous(['config', '--quiet'])
        previous_images = {}
        for name in HOSTS:
            container = previous(['ps', '-q', name]).decode().strip()
            if not container:
                raise ValueError('VPS_EXISTING_SERVICES_REQUIRED')
            info = json.loads(run(['docker', 'inspect', container]))[0]
            if info['State'].get('Health', {}).get('Status') != 'healthy':
                raise ValueError('VPS_EXISTING_SERVICES_MUST_BE_HEALTHY')
            previous_images[name] = info['Image']
        run(['docker', 'load', '-i', str(artifact / 'images.tar.gz')])
        inspected = json.loads(run(['docker', 'image', 'inspect',
                                    *[manifest['images'][app]['reference'] for app in APPS]]))
        loaded_ids = {}
        for app, info in zip(APPS, inspected, strict=True):
            if image_fingerprint(info) != manifest['images'][app]['fingerprint'] or info['Config']['User'] != 'node':
                raise ValueError('VPS_LOADED_IMAGE_MISMATCH')
            loaded_ids[app] = info['Id']
        release.mkdir(mode=0o700)
        for name in ('compose.vps.yml', 'manifest.json'):
            shutil.copyfile(artifact / name, release / name)
        candidate_compose = release / 'compose.vps.yml'
        backup = release / 'backup'
        backup.mkdir(mode=0o700)
        atomic_private(backup / 'vps.env', original)
        atomic_private(backup / 'images.json', json.dumps(previous_images))
        candidate_env = re.sub(r'^KR_BUILD_ID=.*$', 'KR_BUILD_ID=' + manifest['buildId'],
                               original, flags=re.MULTILINE)
        if candidate_env == original:
            raise ValueError('VPS_BUILD_ID_REQUIRED')
        # Validate candidate mounts/dependencies with the current private settings
        # before stopping writers. The build ID changes only image selection.
        compose(candidate_compose, ['config', '--quiet'])
        pg = ['exec', '-T', 'postgres']
        stopped = migrated = False
        phase = 'stop'
        try:
            stopped = True
            previous(['stop', *HOSTS])
            phase = 'backup'
            pg_container = previous(['ps', '-q', 'postgres']).decode().strip()
            stream_command(['docker', 'exec', pg_container, 'pg_dump', '-U', 'kr_cloud_admin',
                            '-d', 'kavaroutes_cloud', '-Fc'], output_path=backup / 'database.dump')
            # Validate the archive with the exact running PostGIS toolchain.
            stream_command(['docker', 'exec', '-i', pg_container, 'pg_restore', '--list'],
                           input_path=backup / 'database.dump')
            for key in STATE_KEYS:
                copy_state(Path(environment[key]), backup / key)
            phase = 'migration'
            atomic_private(env_file, candidate_env)
            migrated = True  # A failed initializer may have committed a migration.
            compose(candidate_compose, ['run', '--rm', '--no-deps', 'initialize'])
            phase = 'health'
            compose(candidate_compose, ['up', '-d', '--no-build', '--no-deps', '--pull', 'never',
                                        '--wait', '--wait-timeout', '180', *HOSTS])
            for name in HOSTS:
                container = compose(candidate_compose, ['ps', '-q', name]).decode().strip()
                info = json.loads(run(['docker', 'inspect', container]))[0]
                if (info['Image'] != loaded_ids[IMAGE_APP[name]]
                        or info['State'].get('Health', {}).get('Status') != 'healthy'):
                    raise ValueError('VPS_PROMOTED_IMAGE_OR_HEALTH_MISMATCH')
            phase = 'activate'
            link = release_root / ('current.next-' + uuid.uuid4().hex)
            link.symlink_to(release.name, target_is_directory=True)
            os.replace(link, current)
            print('VPS_RELEASE_DEPLOYED ' + manifest['buildId'])
        except Exception:
            print('VPS_DEPLOYMENT_FAILED_AT_' + phase.upper(), file=sys.stderr)
            if stopped:
                try:
                    compose(candidate_compose, ['stop', *HOSTS])
                    if migrated:
                        # Preserve post-attempt data under a new database name.
                        # Rollback never drops the failed database or snapshots.
                        failed_db = 'kr_failed_' + uuid.uuid4().hex
                        previous([*pg, 'psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                                  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='kavaroutes_cloud' AND pid<>pg_backend_pid()"])
                        previous([*pg, 'psql', '-U', 'kr_cloud_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
                                  'ALTER DATABASE kavaroutes_cloud RENAME TO ' + failed_db])
                        previous([*pg, 'createdb', '-U', 'kr_cloud_admin', 'kavaroutes_cloud'])
                        stream_command(['docker', 'exec', '-i', previous(['ps', '-q', 'postgres']).decode().strip(),
                                        'pg_restore', '-U', 'kr_cloud_admin', '-d', 'kavaroutes_cloud', '--exit-on-error'],
                                       input_path=backup / 'database.dump')
                        atomic_private(backup / 'failed-database.txt', failed_db + '\n')
                        for key in STATE_KEYS:
                            live = Path(environment[key])
                            failed = live.with_name(live.name + '.failed-' + manifest['buildId'])
                            live.rename(failed)
                            copy_state(backup / key, live)
                    atomic_private(env_file, original)
                    rollback = backup / 'rollback.json'
                    rollback.write_text(json.dumps({'services': {name: {'image': image}
                                        for name, image in previous_images.items()}}))
                    run(['docker', 'compose', '-p', 'kavaroutes-vps', '--env-file', str(env_file),
                         '-f', str(previous_compose), '-f', str(rollback), '--profile', 'admin',
                         'up', '-d', '--no-build', '--no-deps', '--pull', 'never', '--wait',
                         '--wait-timeout', '180', *HOSTS])
                    print('VPS_PREVIOUS_RELEASE_RESTORED', file=sys.stderr)
                except Exception:
                    print('VPS_ROLLBACK_REQUIRES_OPERATOR_REVIEW', file=sys.stderr)
            raise RuntimeError('VPS_DEPLOYMENT_FAILED') from None


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise ValueError('USE_ARTIFACT_COMMIT_ENV_FILE_RELEASE_DIRECTORY')
        deploy(*sys.argv[1:])
    except Exception as error:
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else 'VPS_DEPLOYMENT_FAILED', file=sys.stderr)
        sys.exit(1)
