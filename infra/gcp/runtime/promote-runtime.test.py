"""Local failure-path checks; never invokes Docker or touches the VM."""
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promote', pathlib.Path(__file__).with_name('promote-runtime.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class PromotionTest(unittest.TestCase):
    def scenario(self, fail_migration=False, fail_backup=False):
        with tempfile.TemporaryDirectory(prefix='kr-promotion-test-') as directory:
            root = pathlib.Path(directory)
            original = 'KR_RUNTIME_IMAGE=' + module.OLD + '\nKR_SECRETS_DIRECTORY=/opt/kavaroutes/secrets\n'
            (root / 'vm.env').write_text(original)
            calls = []
            def run(args, data=None, timeout=180):
                calls.append((args, data))
                if 'inspect' in args and '--format' in args:
                    return module.OLD.encode()
                if 'pg_dump' in args:
                    if fail_backup:
                        raise RuntimeError('backup failed')
                    return b'synthetic-archive'
                if fail_migration and args[-1:] == ['initialize']:
                    raise RuntimeError('partial migration')
                return b''
            with patch.object(module, 'ROOT', root), patch.object(module, 'PREVIOUS', root / 'previous.env'), patch.object(module, 'BACKUP', root / 'backups' / 'pre.dump'), patch.object(module, 'run', run), patch.object(module.os, 'geteuid', return_value=0), patch.object(module.sys, 'argv', ['promote', 'sha256:' + '1' * 64]):
                result = module.main()
            flattened = [' '.join(call[0]) for call in calls]
            self.assertFalse(any('dropdb' in c or 'DROP DATABASE' in c for c in flattened))
            if fail_migration:
                self.assertEqual(result, 1)
                self.assertTrue(any('RENAME TO kavaroutes_sol009b_failed' in c for c in flattened))
                self.assertTrue(any('pg_restore' in c and '--exit-on-error' in c for c in flattened))
                self.assertEqual((root / 'vm.env').read_text(), original)
            elif fail_backup:
                self.assertEqual(result, 1)
                self.assertFalse(any('initialize' in c or 'ALTER DATABASE' in c for c in flattened))
                self.assertEqual((root / 'vm.env').read_text(), original)
            else:
                self.assertEqual(result, 0)
                self.assertEqual((root / 'backups' / 'pre.dump').read_bytes(), b'synthetic-archive')
                self.assertIn('sha256:' + '1' * 64, (root / 'vm.env').read_text())
    def test_success(self): self.scenario()
    def test_partial_migration_preserves_failed_database_and_restores_old(self): self.scenario(fail_migration=True)
    def test_backup_failure_prevents_migration(self): self.scenario(fail_backup=True)

if __name__ == '__main__': unittest.main()
