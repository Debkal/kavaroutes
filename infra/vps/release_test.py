import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import deploy
import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.artifact = self.root / 'artifact'
        self.artifact.mkdir()
        self.commit = 'a' * 40
        self.manifest = {'version': 1, 'sourceCommit': self.commit, 'buildId': 'new-release',
                         'images': {}, 'checksums': {}}
        for index, app in enumerate(release.APPS):
            name = 'images.tar.gz'
            (self.artifact / name).write_bytes(b'test archive')
            self.manifest['images'][app] = {'archive': name,
                'reference': f'kavaroutes/{app}:new-release', 'id': 'sha256:' + str(index + 1) * 64,
                'fingerprint': release.image_fingerprint({'Config': {'User': 'node'}})}
        for name in ('compose.vps.yml', 'release.py', 'deploy.py'):
            (self.artifact / name).write_text('test artifact')
        self.write_manifest()

    def write_manifest(self):
        self.manifest['checksums'] = {path.name: release.sha256(path) for path in self.artifact.iterdir()
                                      if path.name != 'manifest.json'}
        (self.artifact / 'manifest.json').write_text(json.dumps(self.manifest))

    def test_modified_archive_is_rejected(self):
        (self.artifact / 'images.tar.gz').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'CHECKSUM'):
            release.verify(self.artifact, self.commit)

    def test_wrong_source_revision_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'MANIFEST'):
            release.verify(self.artifact, 'b' * 40)

    def test_manifest_cannot_escape_artifact_directory(self):
        self.manifest['images']['site']['archive'] = '../private.json'
        self.write_manifest()
        with self.assertRaisesRegex(ValueError, 'IMAGE'):
            release.verify(self.artifact, self.commit)

    def test_private_environment_rejects_shell_expansion(self):
        env = self.root / 'env'
        env.write_text('KR_BUILD_ID=$(cat /private)\n')
        env.chmod(0o600)
        with self.assertRaisesRegex(ValueError, 'ENVIRONMENT_INVALID'):
            deploy.read_environment(env)
        env.write_text('KR_BUILD_ID=old-release\n')
        env.chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'PRIVATE'):
            deploy.read_environment(env)

    def test_image_verification_is_independent_of_docker_store_id(self):
        before = {'Id': 'sha256:' + 'a' * 64, 'Config': {'User': 'node', 'Cmd': ['node', 'server.mjs']},
                  'RootFS': {'Layers': ['sha256:' + 'b' * 64]}}
        after = {**before, 'Id': 'sha256:' + 'c' * 64}
        self.assertEqual(release.image_fingerprint(before), release.image_fingerprint(after))
        after['Config'] = {**before['Config'], 'User': 'root'}
        self.assertNotEqual(release.image_fingerprint(before), release.image_fingerprint(after))

    def test_failed_migration_preserves_attempt_data_and_restores_exact_old_images(self):
        self.deployment_drill('migration')

    def test_failed_health_restores_all_persistent_application_state(self):
        self.deployment_drill('health')

    def deployment_drill(self, failure):
        release_root = self.root / 'releases'
        bootstrap = release_root / 'bootstrap'
        bootstrap.mkdir(parents=True)
        (bootstrap / 'compose.vps.yml').write_text('old compose')
        (release_root / 'current').symlink_to('bootstrap', target_is_directory=True)
        env = self.root / 'env'
        values = {'KR_BUILD_ID': 'old-release'}
        for key in (*deploy.STATE_KEYS, 'KR_SECRETS_DIRECTORY', 'KR_GOOGLE_DIRECTORY'):
            path = self.root / key
            path.mkdir()
            (path / 'marker').write_text('old state')
            values[key] = str(path)
        secrets = Path(values['KR_SECRETS_DIRECTORY'])
        access = Path(values['KR_DRIVER_ACCESS_DIRECTORY']) / 'access.json'
        access.write_text(json.dumps({'version': 1, 'codes': [], 'devices': [],
                                      'events': [], 'driverTokens': []}))
        access.chmod(0o640)
        for role, port in (('admin', 58082), ('api', 58082), ('worker', 58081)):
            path = secrets / (role + '.json')
            path.write_text(json.dumps({'profile': 'business-authenticated', 'port': port}))
            path.chmod(0o600)
        path = Path(values['KR_ADMIN_DIRECTORY']) / 'config.json'
        path.write_text(json.dumps({'mode': 'cloudflare', 'port': 58100,
                                   'database': '/var/lib/kavaroutes-admin/admin.sqlite'}))
        path.chmod(0o600)
        original = ''.join(f'{key}={value}\n' for key, value in values.items())
        env.write_text(original)
        env.chmod(0o600)
        calls = []

        def mocked_run(args, **kwargs):
            calls.append(args)
            if args[:3] == ['docker', 'image', 'inspect']:
                return json.dumps([{'Id': self.manifest['images'][reference.split('/')[1].split(':')[0]]['id'],
                                    'Config': {'User': 'node'}} for reference in args[3:]]).encode()
            if args[:2] == ['docker', 'inspect']:
                host = args[-1].removeprefix('container-')
                return json.dumps([{'Image': 'sha256:' + 'f' * 64,
                                    'State': {'Health': {'Status': 'healthy'}}}]).encode()
            if 'ps' in args:
                return ('container-' + args[-1]).encode()
            if args[-1] == 'initialize':
                for key in deploy.STATE_KEYS:
                    (Path(values[key]) / 'marker').write_text('attempt state')
                if failure == 'migration':
                    raise RuntimeError('MOCK_MIGRATION_FAILED')
            if failure == 'health' and 'up' in args and 'rollback.json' not in ' '.join(args):
                raise RuntimeError('MOCK_HEALTH_FAILED')
            return b''

        streams = []

        def mocked_stream(args, **kwargs):
            streams.append(args)
            if kwargs.get('output_path'):
                kwargs['output_path'].write_bytes(b'verified backup')

        with patch.object(deploy.os, 'geteuid', return_value=0), patch.object(deploy, 'run', mocked_run), \
                patch.object(deploy, 'stream_command', mocked_stream), \
                contextlib.redirect_stderr(io.StringIO()) as output:
            with self.assertRaisesRegex(RuntimeError, 'DEPLOYMENT_FAILED'):
                deploy.deploy(self.artifact, self.commit, env, release_root)
        self.assertIn('VPS_PREVIOUS_RELEASE_RESTORED', output.getvalue())
        self.assertEqual(env.read_text(), original)
        self.assertEqual((release_root / 'current').resolve(), bootstrap)
        for key in deploy.STATE_KEYS:
            live = Path(values[key])
            self.assertEqual((live / 'marker').read_text(), 'old state')
            self.assertEqual((live.with_name(live.name + '.failed-new-release') / 'marker').read_text(), 'attempt state')
            self.assertEqual(live.stat().st_uid, os.getuid())
        rollback = json.loads((release_root / 'new-release/backup/rollback.json').read_text())
        self.assertTrue(all(value['image'] == 'sha256:' + 'f' * 64 for value in rollback['services'].values()))
        sql = '\n'.join(' '.join(args) for args in calls)
        self.assertIn('ALTER DATABASE kavaroutes_cloud RENAME TO kr_failed_', sql)
        self.assertNotIn('DROP DATABASE', sql)
        self.assertTrue(any('--exit-on-error' in args for args in streams))


if __name__ == '__main__':
    unittest.main()
