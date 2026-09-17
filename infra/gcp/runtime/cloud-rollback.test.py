"""Local drill-path checks for cloud-rollback.py; never invokes Docker or touches the VM."""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess as real_subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('rollback', pathlib.Path(__file__).with_name('cloud-rollback.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ACCEPTED = module.REPOSITORY + '@sha256:' + 'a' * 64
DRIFTED = module.REPOSITORY + '@sha256:' + 'b' * 64
UNPINNED = module.REPOSITORY + '@latest'
EVIDENCE = b'1|md5-trips|10\n2|md5-migrations|28\n'


class Scenario:
    def __init__(self, flags=()):
        self.flags = set(flags)
        self.calls = []
        self.evidence_calls = 0

    def dispatch(self, args, **kwargs):
        self.calls.append(list(args))
        if args[0] == 'docker' and args[1:2] == ['inspect']:
            fmt = args[args.index('--format') + 1]
            if 'State' in fmt:
                running = 'stays-running' in self.flags
                code = 0 if 'zero-exit' in self.flags else 1
                return SimpleNamespace(stdout=json.dumps({'Running': running, 'ExitCode': 0 if running else code}).encode())
            return SimpleNamespace(stdout=(DRIFTED if 'drift' in self.flags else ACCEPTED).encode())
        if args[0] == 'docker' and args[1:2] == ['logs']:
            stdout = b'leaked detail' if 'open-stdout' in self.flags else b''
            stderr = b'another failure' if 'wrong-stderr' in self.flags else b'RUNTIME_START_FAILED\n'
            return SimpleNamespace(stdout=stdout, stderr=stderr, returncode=0)
        if args[0] == 'docker' and args[1:2] == ['exec']:
            self.evidence_calls += 1
            if 'evidence-change' in self.flags and self.evidence_calls > 1:
                return SimpleNamespace(stdout=b'different evidence')
            return SimpleNamespace(stdout=EVIDENCE)
        if 'smoke' in ' '.join(args) and 'restore-failure' not in self.flags:
            return SimpleNamespace(stdout=b'')
        if args[:3] == ['docker', 'compose', '--env-file'] and '-d' in args and '--no-deps' not in args:
            if 'restore-failure' in self.flags:
                raise real_subprocess.CalledProcessError(1, args)
            return SimpleNamespace(stdout=b'')
        return SimpleNamespace(stdout=b'')


def scenario(flags=()):
    directory = tempfile.TemporaryDirectory(prefix='kr-rollback-test-')
    root = pathlib.Path(directory.name)
    environment = Scenario(flags)
    image = UNPINNED if 'unpinned' in flags else ACCEPTED
    (root / 'vm.env').write_text('KR_RUNTIME_IMAGE=' + image + '\nKR_SECRETS_DIRECTORY=/opt/kavaroutes/secrets\n')
    rejected = root / 'rollback-rejected.yaml'
    if 'missing-rejected' not in flags:
        rejected.write_text('services:\n  api:\n    command: [api, /run/secrets/missing.json]\n')
    output = io.StringIO()
    with patch.object(module, 'ROOT', root), patch.object(module, 'REJECTED', rejected), \
         patch.object(module, 'SMOKE', root / 'cloud-smoke.py'), patch.object(module, 'API', 'kavaroutes-cloud-api-1'), \
         patch.object(module, 'POSTGRES', 'kavaroutes-cloud-postgres-1'), \
         patch.object(module, 'subprocess', SimpleNamespace(run=environment.dispatch,
             CalledProcessError=real_subprocess.CalledProcessError, PIPE=real_subprocess.PIPE,
             DEVNULL=real_subprocess.DEVNULL, STDOUT=real_subprocess.STDOUT)), \
         patch.object(module.time, 'sleep', lambda _seconds: None), contextlib.redirect_stdout(output):
        result = module.main()
    directory.cleanup()
    return SimpleNamespace(result=result, output=output.getvalue(), calls=environment.calls,
                           flags=set(flags), root=root, directory=directory)


class RefusalTest(unittest.TestCase):
    def test_unpinned_configuration_is_refused_before_any_mutation(self):
        run = scenario(['unpinned'])
        self.assertEqual(run.result, 1)
        self.assertEqual(run.output.strip(), 'CLOUD_ROLLBACK_REQUIRES_REVIEW')
        self.assertEqual([call for call in run.calls if 'up' in call], [])

    def test_running_container_drifted_from_the_accepted_image_is_refused(self):
        run = scenario(['drift'])
        self.assertEqual(run.result, 1)
        self.assertEqual(run.output.strip(), 'CLOUD_ROLLBACK_REQUIRES_REVIEW')
        self.assertEqual([call for call in run.calls if 'up' in call], [])

    def test_missing_rejected_configuration_is_refused(self):
        run = scenario(['missing-rejected'])
        self.assertEqual(run.result, 1)
        self.assertEqual(run.output.strip(), 'CLOUD_ROLLBACK_REQUIRES_REVIEW')
        self.assertEqual([call for call in run.calls if 'up' in call], [])


class DrillTest(unittest.TestCase):
    def report(self, run):
        return json.loads([line for line in run.output.splitlines() if line.startswith('{')][-1])

    def test_passing_drill_restores_the_accepted_image_and_reports_evidence(self):
        run = scenario()
        self.assertEqual(run.result, 0)
        report = self.report(run)
        self.assertEqual(report['result'], 'CLOUD_CONFIG_ROLLBACK_PASSED')
        self.assertEqual(report['image'], ACCEPTED)
        self.assertEqual(report['evidenceSha256'], hashlib.sha256(EVIDENCE).hexdigest())
        self.assertIn('known-good-digest-restored', report['checks'])
        self.assertTrue(any('cloud-smoke.py' in ' '.join(call) for call in run.calls))
        restores = [call for call in run.calls if call[:3] == ['docker', 'compose', '--env-file'] and 'worker' in call]
        self.assertEqual(len(restores), 1)
        self.assertIn('--wait-timeout', restores[0])

    def test_open_stdout_from_the_bad_configuration_fails_the_drill_and_still_restores(self):
        run = scenario(['open-stdout'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_CONFIG_ROLLBACK_FAILED', run.output)
        self.assertTrue(any('worker' in call for call in run.calls))

    def test_wrong_stderr_token_fails_the_drill(self):
        run = scenario(['wrong-stderr'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_CONFIG_ROLLBACK_FAILED', run.output)

    def test_zero_exit_from_the_bad_configuration_fails_the_drill(self):
        run = scenario(['zero-exit'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_CONFIG_ROLLBACK_FAILED', run.output)

    def test_container_that_keeps_running_fails_the_bounded_wait(self):
        run = scenario(['stays-running'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_CONFIG_ROLLBACK_FAILED', run.output)

    def test_changed_evidence_fails_the_drill(self):
        run = scenario(['evidence-change'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_CONFIG_ROLLBACK_FAILED', run.output)

    def test_restore_failure_is_reported_and_exits_non_zero(self):
        run = scenario(['restore-failure'])
        self.assertEqual(run.result, 1)
        self.assertIn('CLOUD_ROLLBACK_RESTORE_FAILED', run.output)


if __name__ == '__main__':
    unittest.main()
