"""Build once, export and verify a complete release without production secrets."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

APPS = ('runtime', 'gateway', 'site', 'admin')
BUILD_ID = re.compile(r'[a-z0-9][a-z0-9.-]{2,95}')
COMMIT = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'sha256:[0-9a-f]{64}')


def image_fingerprint(info):
    # Docker's public image ID differs between classic and containerd stores.
    # Bind the executable configuration and ordered content-addressed filesystem
    # layers instead, so the same archive can be verified on either VPS engine.
    config = info['Config']
    defaults = {'User': '', 'Env': [], 'Entrypoint': [], 'Cmd': [], 'WorkingDir': '',
                'Labels': {}, 'Volumes': {}, 'ExposedPorts': {}, 'StopSignal': ''}
    selected = {key: config.get(key) or default for key, default in defaults.items()}
    health = config.get('Healthcheck') or {}
    selected['Healthcheck'] = {key: health.get(key, [] if key == 'Test' else 0)
                              for key in ('Test', 'Interval', 'Timeout', 'Retries', 'StartPeriod', 'StartInterval')}
    payload = {'architecture': info.get('Architecture'), 'os': info.get('Os'),
               'config': selected, 'layers': info.get('RootFS', {}).get('Layers', [])}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def run(args, **kwargs):
    # Never forward raw subprocess errors: deployment commands read private files.
    try:
        return subprocess.run(args, check=True, capture_output=True, timeout=900,
                              **kwargs).stdout
    except subprocess.SubprocessError:
        raise RuntimeError('RELEASE_COMMAND_FAILED_' + args[0].upper()) from None


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(directory, source_commit):
    directory = Path(directory)
    if (directory / 'manifest.json').is_symlink():
        raise ValueError('RELEASE_MANIFEST_INVALID')
    manifest = json.loads((directory / 'manifest.json').read_text())
    if (manifest.get('version') != 1 or not COMMIT.fullmatch(source_commit)
            or manifest.get('sourceCommit') != source_commit
            or not BUILD_ID.fullmatch(manifest.get('buildId', ''))
            or set(manifest.get('images', {})) != set(APPS)):
        raise ValueError('RELEASE_MANIFEST_INVALID')
    expected_files = {'compose.vps.yml', 'release.py', 'deploy.py', 'images.tar.gz'}
    for app, image in manifest['images'].items():
        if (image.get('archive') != 'images.tar.gz' or not DIGEST.fullmatch(image.get('id', ''))
                or not re.fullmatch(r'[0-9a-f]{64}', image.get('fingerprint', ''))
                or image.get('reference') != f'kavaroutes/{app}:{manifest["buildId"]}'):
            raise ValueError('RELEASE_IMAGE_INVALID')
    if set(manifest.get('checksums', {})) != expected_files:
        raise ValueError('RELEASE_FILES_INVALID')
    for name, expected in manifest['checksums'].items():
        path = directory / name
        if path.is_symlink() or not path.is_file() or sha256(path) != expected:
            raise ValueError('RELEASE_CHECKSUM_FAILED')
    return manifest


def build(root, directory, build_id, source_commit):
    if not BUILD_ID.fullmatch(build_id) or not COMMIT.fullmatch(source_commit):
        raise ValueError('RELEASE_ARGUMENT_INVALID')
    if run(['git', '-C', str(root), 'rev-parse', 'HEAD']).decode().strip() != source_commit:
        raise ValueError('RELEASE_SOURCE_MISMATCH')
    directory.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix='kr-release-') as temporary:
        secrets = Path(temporary)
        for name in ('geoapify.env', 'site.env'):
            (secrets / name).touch(mode=0o600)
        env = {**os.environ, 'KR_BUILD_ID': build_id, 'KR_SECRETS_DIRECTORY': temporary}
        compose = ['docker', 'compose', '--env-file', str(root / 'infra/vps/.env.example'),
                   '-f', str(root / 'compose.vps.yml'), '--profile', 'admin']
        run(compose + ['config', '--quiet'], env=env)
        print('BUILDING_VPS_RELEASE', flush=True)
        # Compose/BuildKit reuse common layers; runtime is built once for API/worker.
        run(compose + ['build'], env=env, cwd=root)
    manifest = {'version': 1, 'buildId': build_id, 'sourceCommit': source_commit,
                'images': {}, 'checksums': {}}
    references = [f'kavaroutes/{app}:{build_id}' for app in APPS]
    inspected = json.loads(run(['docker', 'image', 'inspect', *references]))
    for app, reference, info in zip(APPS, references, inspected, strict=True):
        if info['Config']['User'] != 'node':
            raise ValueError('RELEASE_NONROOT_IMAGE_REQUIRED')
        manifest['images'][app] = {'reference': reference, 'id': info['Id'],
                                  'fingerprint': image_fingerprint(info), 'archive': 'images.tar.gz'}
    # One archive stores shared Node/dependency layers once and one import loads
    # the complete release. Stream compression instead of buffering image bytes.
    with tempfile.TemporaryFile() as error_stream:
        process = subprocess.Popen(['docker', 'save', *references], stdout=subprocess.PIPE,
                                   stderr=error_stream)
        try:
            with gzip.open(directory / 'images.tar.gz', 'wb', compresslevel=1) as output:
                shutil.copyfileobj(process.stdout, output, length=1024 * 1024)
            if process.wait(timeout=300) != 0:
                raise RuntimeError('RELEASE_IMAGE_EXPORT_FAILED')
        finally:
            process.stdout.close()
            if process.poll() is None:
                process.kill()
                process.wait()
    for name, source in {'compose.vps.yml': root / 'compose.vps.yml',
                         'release.py': root / 'infra/vps/release.py',
                         'deploy.py': root / 'infra/vps/deploy.py'}.items():
        shutil.copyfile(source, directory / name)
    manifest['checksums'] = {path.name: sha256(path) for path in directory.iterdir()}
    (directory / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    verify(directory, source_commit)
    print('VPS_RELEASE_EXPORTED', flush=True)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 5 and sys.argv[1] == 'build':
            build(Path(__file__).resolve().parents[2], Path(sys.argv[2]).resolve(),
                  sys.argv[3], sys.argv[4])
        elif len(sys.argv) == 4 and sys.argv[1] == 'verify':
            verify(sys.argv[2], sys.argv[3])
            print('VPS_RELEASE_VERIFIED')
        else:
            raise ValueError('USE_BUILD_OUTPUT_BUILD_ID_COMMIT_OR_VERIFY_OUTPUT_COMMIT')
    except Exception as error:
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else 'VPS_RELEASE_FAILED',
              file=sys.stderr)
        sys.exit(1)
