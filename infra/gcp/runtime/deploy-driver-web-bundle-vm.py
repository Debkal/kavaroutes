"""Atomically replace the gated Driver web bundle on the existing VM."""
import http.client
import os
import pathlib
import re
import shutil
import sys
import tarfile

WEB = pathlib.Path('/opt/kavaroutes/web')


def main():
    if os.geteuid() != 0 or len(sys.argv) != 3 or not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,31}', sys.argv[1]):
        raise ValueError('invalid invocation')
    label = sys.argv[1]
    archive = pathlib.Path(sys.argv[2])
    live = WEB / 'dist-driver'
    candidate = WEB / ('dist-driver.next-' + label)
    previous = WEB / ('dist-driver.pre-' + label)
    failed = WEB / ('dist-driver.failed-' + label)
    if not live.is_dir() or live.is_symlink() or not archive.is_file() or any(path.exists() for path in (candidate, previous, failed)):
        raise ValueError('driver web state requires review')
    candidate.mkdir(mode=0o755)
    swapped = False
    try:
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            if sum(member.size for member in members) > 50_000_000:
                raise ValueError('driver web bundle too large')
            for member in members:
                parts = pathlib.PurePosixPath(member.name).parts
                if not parts or parts[0] != 'dist-driver' or '..' in parts or member.issym() or member.islnk():
                    raise ValueError('invalid driver web bundle entry')
                if len(parts) == 1:
                    continue
                destination = candidate.joinpath(*parts[1:])
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    with bundle.extractfile(member) as source, destination.open('xb') as output:
                        shutil.copyfileobj(source, output)
                    destination.chmod(0o644)
                else:
                    raise ValueError('invalid driver web bundle entry')
        if not (candidate / 'driver.html').is_file() or not list((candidate / 'assets').glob('cloud-driver-route-*.js')):
            raise ValueError('driver web bundle incomplete')
        # Existing tabs may request an older hashed asset after the switch.
        for source in (live / 'assets').rglob('*'):
            if source.is_file() and not source.is_symlink():
                destination = candidate / 'assets' / source.relative_to(live / 'assets')
                if not destination.exists():
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, destination)
        live.rename(previous)
        swapped = True
        candidate.rename(live)
        connection = http.client.HTTPConnection('127.0.0.1', 58080, timeout=10)
        try:
            connection.request('GET', '/driver', headers={'Host': 'driver.kavaroutes.com'})
            response = connection.getresponse()
            response.read(100_000)
            if response.status != 303 or not response.getheader('location', '').startswith('/business-access?'):
                raise ValueError('driver business gate smoke failed')
        finally:
            connection.close()
        print('DRIVER_WEB_DEPLOYED')
    except Exception:
        if swapped:
            if live.exists():
                live.rename(failed)
            previous.rename(live)
        print('DRIVER_WEB_DEPLOY_FAILED')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit(1)
