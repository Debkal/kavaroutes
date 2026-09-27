"""Atomically replace the VM web bundle while retaining its previous assets."""
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
    live = WEB / 'dist'
    candidate = WEB / ('dist.next-' + label)
    previous = WEB / ('dist.pre-' + label)
    failed = WEB / ('dist.failed-' + label)
    if not live.is_dir() or live.is_symlink() or not archive.is_file() or any(path.exists() for path in (candidate, previous, failed)):
        raise ValueError('web state requires review')
    candidate.mkdir(mode=0o755)
    swapped = False
    try:
        with tarfile.open(archive, 'r:gz') as bundle:
            members = bundle.getmembers()
            if sum(member.size for member in members) > 50_000_000:
                raise ValueError('web bundle too large')
            for member in members:
                parts = pathlib.PurePosixPath(member.name).parts
                if not parts or parts[0] != 'dist' or '..' in parts or member.issym() or member.islnk():
                    raise ValueError('invalid web bundle entry')
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
                    raise ValueError('invalid web bundle entry')
        if not (candidate / 'index.html').is_file() or not list((candidate / 'assets').glob('cloud-route-history-route-*.js')):
            raise ValueError('route history web bundle incomplete')
        # Browser tabs opened before this switch may still request old hashed assets.
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
            connection.request('GET', '/route-history', headers={'Host': 'app.kavaroutes.com'})
            response = connection.getresponse()
            body = response.read(1_000_000)
            if response.status != 200 or b'id="root"' not in body:
                raise ValueError('route history gateway smoke failed')
        finally:
            connection.close()
        print('ROUTE_HISTORY_WEB_DEPLOYED')
    except Exception:
        if swapped:
            if live.exists():
                live.rename(failed)
            previous.rename(live)
        print('ROUTE_HISTORY_WEB_DEPLOY_FAILED')
        raise


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit(1)
