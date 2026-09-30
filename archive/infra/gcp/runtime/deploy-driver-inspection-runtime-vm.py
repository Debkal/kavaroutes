"""Update the four VM-mounted Driver inspection runtime modules with rollback."""
import http.client
import pathlib
import re
import shutil
import subprocess
import sys

WEB = pathlib.Path('/opt/kavaroutes/web')
RUNTIME = pathlib.Path('/opt/kavaroutes/runtime')
FILES = ('api.mjs', 'driver-access-management.mjs', 'driver-access-store.mjs', 'driver-business-gate.mjs')
BASE = ['docker', 'compose', '--env-file', str(RUNTIME / 'vm.env'), '-f', str(RUNTIME / 'compose.yaml'), '-f', str(RUNTIME / 'prototype-compose.override.yaml')]


def healthy():
    for host, path, expected in (('app.kavaroutes.com', '/health/ready', 200),
                                 ('driver.kavaroutes.com', '/driver', 303),
                                 ('driver.kavaroutes.com', '/driver-inspection-settings', 404)):
        connection = http.client.HTTPConnection('127.0.0.1', 58080, timeout=12)
        try:
            connection.request('GET', path, headers={'Host': host})
            response = connection.getresponse()
            response.read(1_000_000)
            if response.status != expected:
                raise RuntimeError(f'health check failed: {host}{path} returned {response.status}')
        finally:
            connection.close()


def recreate():
    for service in ('api', 'gateway'):
        subprocess.run(BASE + ['up', '-d', '--wait', '--wait-timeout', '120', '--pull', 'never', '--force-recreate', '--no-deps', service], check=True, timeout=180)


def main():
    if len(sys.argv) != 3 or not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,31}', sys.argv[1]):
        raise ValueError('invalid invocation')
    label = sys.argv[1]
    stage = pathlib.Path(sys.argv[2])
    if not stage.is_dir() or stage.is_symlink() or any(not (stage / name).is_file() or (stage / name).is_symlink() for name in FILES):
        raise ValueError('incomplete runtime stage')
    backups = {name: WEB / f'{name}.pre-{label}' for name in FILES}
    if any(path.exists() for path in backups.values()):
        raise ValueError('deployment label already used')
    installed = []
    for name in FILES:
        live = WEB / name
        if not live.is_file() or live.is_symlink():
            raise ValueError(f'missing live module: {name}')
        shutil.copy2(live, backups[name])
    try:
        for name in FILES:
            target = WEB / name
            temporary = WEB / f'.{name}.next-{label}'
            shutil.copy2(stage / name, temporary)
            temporary.chmod(0o644)
            temporary.replace(target)
            installed.append(name)
        recreate()
        healthy()
    except Exception:
        for name in installed:
            shutil.copy2(backups[name], WEB / name)
        recreate()
        healthy()
        raise
    print('DRIVER_INSPECTION_RUNTIME_DEPLOYED')


if __name__ == '__main__':
    main()
