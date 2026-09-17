"""Local failure-path checks; never invokes Docker or touches the VM."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promote', pathlib.Path(__file__).with_name('promote-runtime.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

TARGET_DIGEST = 'sha256:' + '1' * 64
TARGET_IMAGE = module.REPOSITORY + '@' + TARGET_DIGEST
LIVE_IMAGE = module.REPOSITORY + '@sha256:' + 'a' * 64
DEFAULT_LABEL = '111111111111'
REFUSALS = (('bad-digest',), ('no-op',), ('existing-backup',), ('source-drift',), ('failed-exists',))


class PromotionTest(unittest.TestCase):
    def scenario(self, flags=()):
        directory = tempfile.TemporaryDirectory(prefix='kr-promotion-test-')
        self.addCleanup(directory.cleanup)
        root = pathlib.Path(directory.name)
        backups = root / 'backups'
        original = 'KR_RUNTIME_IMAGE=' + LIVE_IMAGE + '\nKR_SECRETS_DIRECTORY=/opt/kavaroutes/secrets\n'
        (root / 'vm.env').write_text(original)
        calls = []
        promoted = [False]

        def run(args, data=None, timeout=180):
            calls.append((args, data))
            joined = ' '.join(args)
            if '--format' in args:
                fmt = args[args.index('--format') + 1]
                if 'State.Health' in fmt:
                    return b'unhealthy' if 'unhealthy' in flags else b'healthy'
                if 'source-drift' in flags:
                    return (LIVE_IMAGE.replace('sha256:' + 'a' * 64, 'sha256:' + 'b' * 64)).encode()
                if 'image-mismatch' in flags and args[-1].endswith('worker-1'):
                    return LIVE_IMAGE.encode()
                return (TARGET_IMAGE if promoted[0] else LIVE_IMAGE).encode()
            if args[1:2] == ['image']:
                return b''
            if args[0] == 'docker' and args[1:2] == ['exec'] and 'FROM pg_database' in joined:
                return b'1' if 'failed-exists' in flags else b'0'
            if 'pg_dump' in args:
                if 'backup-failure' in flags:
                    raise RuntimeError('backup failed')
                return b'synthetic-archive'
            if 'kavaroutes_schema_migration' in joined:
                return b'0028_synthetic\n'
            if args[-1:] == ['initialize'] and 'migration-failure' in flags:
                raise RuntimeError('partial migration')
            if 'up' in args and '-d' in args:
                promoted[0] = True
            return b''

        argv = ['promote', TARGET_DIGEST]
        if 'explicit-label' in flags:
            argv.append('candidate-2')
        if 'bad-digest' in flags:
            argv[1] = 'sha256:not-a-digest'
        if 'no-op' in flags:
            argv[1] = 'sha256:' + 'a' * 64
        label = 'candidate-2' if 'explicit-label' in flags else DEFAULT_LABEL
        if 'existing-backup' in flags:
            backups.mkdir(mode=0o700)
            (backups / (label + '-before.dump')).write_bytes(b'old')
        output = io.StringIO()
        refused = False
        result = None
        with patch.object(module, 'ROOT', root), patch.object(module, 'BACKUP_DIR', backups), \
             patch.object(module, 'run', run), patch.object(module.time, 'sleep', lambda _seconds: None), \
             patch.object(module.os, 'geteuid', return_value=0), patch.object(module.sys, 'argv', argv), \
             contextlib.redirect_stdout(output):
            if tuple(flags) in REFUSALS:
                with self.assertRaises(ValueError):
                    module.main()
                refused = True
            else:
                result = module.main()
        return {'calls': calls, 'root': root, 'backups': backups, 'label': label, 'output': output.getvalue(),
            'result': result, 'refused': refused, 'env': (root / 'vm.env').read_text(), 'original': original}

    def flattened(self, scenario):
        return [' '.join(call[0]) for call in scenario['calls']]

    def record(self, scenario):
        return json.loads([line for line in scenario['output'].splitlines() if line.startswith('{')][-1])

    def test_success_records_rollback_target_and_verifies_the_promotion(self):
        scenario = self.scenario()
        self.assertEqual(scenario['result'], 0)
        self.assertEqual((scenario['backups'] / (scenario['label'] + '-before.dump')).read_bytes(), b'synthetic-archive')
        self.assertIn(TARGET_DIGEST, scenario['env'])
        self.assertTrue((scenario['root'] / ('vm.env.pre-' + scenario['label'])).exists())
        self.assertEqual(self.record(scenario)['previousImage'], LIVE_IMAGE)
        self.assertEqual(self.record(scenario)['rollbackImage'], LIVE_IMAGE)
        self.assertEqual(self.record(scenario)['schema'], '0028_synthetic')
        self.assertIn('vm.env.pre-' + scenario['label'], self.record(scenario)['previousConfig'])
        self.assertTrue(any('initialize' in call for call in self.flattened(scenario)))
        self.assertFalse(any('dropdb' in call or 'DROP DATABASE' in call for call in self.flattened(scenario)))
        self.assertTrue(any('pg_restore --list' in call for call in self.flattened(scenario)))

    def test_partial_migration_preserves_failed_database_and_restores_old(self):
        scenario = self.scenario(['migration-failure'])
        self.assertEqual(scenario['result'], 1)
        self.assertTrue(any('RENAME TO kavaroutes_cloud_' + scenario['label'] + '_failed' in call for call in self.flattened(scenario)))
        self.assertTrue(any('pg_restore' in call and '--exit-on-error' in call for call in self.flattened(scenario)))
        self.assertEqual(scenario['env'], scenario['original'])
        self.assertFalse(any('dropdb' in call or 'DROP DATABASE' in call for call in self.flattened(scenario)))

    def test_backup_failure_prevents_migration(self):
        scenario = self.scenario(['backup-failure'])
        self.assertEqual(scenario['result'], 1)
        self.assertFalse(any('initialize' in call or 'ALTER DATABASE' in call for call in self.flattened(scenario)))
        self.assertEqual(scenario['env'], scenario['original'])

    def test_unhealthy_containers_roll_the_promotion_back(self):
        scenario = self.scenario(['unhealthy'])
        self.assertEqual(scenario['result'], 1)
        self.assertTrue(any('ALTER DATABASE' in call for call in self.flattened(scenario)))
        self.assertEqual(scenario['env'], scenario['original'])

    def test_a_promoted_container_running_the_wrong_image_rolls_back(self):
        scenario = self.scenario(['image-mismatch'])
        self.assertEqual(scenario['result'], 1)
        self.assertTrue(any('ALTER DATABASE' in call for call in self.flattened(scenario)))
        self.assertEqual(scenario['env'], scenario['original'])

    def test_refusals_happen_before_downtime(self):
        for flags in REFUSALS:
            with self.subTest(flags=flags):
                scenario = self.scenario(flags)
                self.assertTrue(scenario['refused'])
                self.assertEqual(list(scenario['root'].glob('vm.env.pre-*')), [])
                if 'existing-backup' not in flags:
                    self.assertEqual(list(scenario['backups'].glob('*')) if scenario['backups'].exists() else [], [])

    def test_an_explicit_label_names_every_artifact(self):
        scenario = self.scenario(['explicit-label'])
        self.assertEqual(scenario['result'], 0)
        self.assertTrue((scenario['root'] / 'vm.env.pre-candidate-2').exists())
        self.assertTrue((scenario['backups'] / 'candidate-2-before.dump').exists())


if __name__ == '__main__':
    unittest.main()
