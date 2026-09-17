"""Local tag/lifecycle checks; never invokes gcloud, docker or the network."""
import contextlib
import importlib.util
import io
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('push', pathlib.Path(__file__).with_name('push-runtime.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ACCEPTED = ['sol004-20260913', 'sol009b-20260915', 'cq008-20260917', 'runtime-20260916', 'cand-20260101']
REJECTED = ['latest', 'SOL009B-20260915', 'sol009b', 'sol009b-2026', 'a-20260915', 'sol009b-2026091', 'sol009b-202609155',
    '../evil-20260915', 'sol009b-20260915-extra', ' sol009b-20260915', '-20260915', 'sol009b-20259999', '']


class PushTagTest(unittest.TestCase):
    def test_accepted_reviewed_tag_shapes(self):
        for tag in ACCEPTED:
            with self.subTest(tag=tag):
                self.assertTrue(module.reviewed_tag(tag))

    def test_rejected_tag_shapes(self):
        for tag in REJECTED:
            with self.subTest(tag=tag):
                self.assertFalse(module.reviewed_tag(tag))

    def test_a_rejected_tag_never_reaches_a_subprocess(self):
        for tag in REJECTED:
            with self.subTest(tag=tag):
                with patch.object(module.subprocess, 'run', side_effect=AssertionError('subprocess must not run')), \
                     patch.object(module, 'at_repository_root', return_value=True):
                    with self.assertRaises(SystemExit) as raised:
                        module.main(['push-runtime.py', tag])
                self.assertEqual(raised.exception.code, 'REVIEWED_RUNTIME_TAG_REQUIRED')

    def test_the_wrong_arguments_or_directory_are_refused(self):
        for argv, root_ok in ((['push-runtime.py'], True), (['push-runtime.py', 'cq008-20260917', 'extra'], True),
                              (['push-runtime.py', 'cq008-20260917'], False)):
            with self.subTest(argv=argv, root_ok=root_ok):
                with patch.object(module.subprocess, 'run', side_effect=AssertionError('subprocess must not run')), \
                     patch.object(module, 'at_repository_root', return_value=root_ok):
                    with self.assertRaises(SystemExit) as raised:
                        module.main(argv)
                self.assertEqual(raised.exception.code, 'REVIEWED_RUNTIME_TAG_REQUIRED')

    def scenario(self, fail_push=False):
        directory = tempfile.TemporaryDirectory(prefix='kr-push-test-')
        self.addCleanup(directory.cleanup)
        fake_root = pathlib.Path(directory.name)
        (fake_root / '.tooling' / 'gcp').mkdir(parents=True)
        calls = []

        def run(args, **kwargs):
            calls.append((args, kwargs))
            if fail_push and 'push' in args:
                raise RuntimeError('registry rejected the upload')
            return types.SimpleNamespace(stdout=b'synthetic-token')

        output = io.StringIO()
        with patch.object(module, 'root', fake_root), patch.object(module, 'at_repository_root', return_value=True), \
             patch.object(module.subprocess, 'run', run), contextlib.redirect_stdout(output):
            if fail_push:
                with self.assertRaises(SystemExit) as raised:
                    module.main(['push-runtime.py', 'cq008-20260917'])
                return calls, output.getvalue(), raised.exception.code
            module.main(['push-runtime.py', 'cq008-20260917'])
            return calls, output.getvalue(), 0

    def test_a_successful_push_logs_in_pushes_and_always_logs_out(self):
        calls, output, code = self.scenario()
        flattened = [' '.join(str(part) for part in call[0]) for call in calls]
        self.assertEqual(code, 0)
        self.assertIn('RUNTIME_CANDIDATE_PUSHED', output)
        self.assertTrue(any('print-access-token' in call for call in flattened))
        self.assertTrue(any('login --username oauth2accesstoken --password-stdin us-west1-docker.pkg.dev' in call for call in flattened))
        self.assertTrue(any('push us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:cq008-20260917' in call for call in flattened))
        self.assertTrue(flattened[-1].endswith('logout us-west1-docker.pkg.dev'))  # finally always runs
        self.assertNotIn('synthetic-token', output)

    def test_a_failed_push_reports_failure_and_still_logs_out(self):
        calls, output, code = self.scenario(fail_push=True)
        flattened = [' '.join(str(part) for part in call[0]) for call in calls]
        self.assertEqual(code, 'RUNTIME_PUSH_FAILED')
        self.assertTrue(any('push us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:cq008-20260917' in call for call in flattened))
        self.assertTrue(flattened[-1].endswith('logout us-west1-docker.pkg.dev'))
        self.assertNotIn('synthetic-token', output)


if __name__ == '__main__':
    unittest.main()
