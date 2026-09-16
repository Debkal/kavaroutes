import importlib.util
import json
import unittest
import io
from contextlib import redirect_stdout
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('health', Path(__file__).with_name('cloud-health.py'))
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)


class HealthTests(unittest.TestCase):
    def test_closed_health(self):
        for status, body, expected in [(200, b'{"status":"ready"}', True),
                                       (503, b'{"status":"ready"}', False),
                                       (200, b'{"status":"ready","patient":"CANARY_PHI"}', False),
                                       (200, b'CANARY_SECRET', False)]:
            with patch.object(health, 'exchange', return_value=(status, body)):
                self.assertEqual(health.ready('worker'), expected)
        with patch.object(health, 'exchange', return_value=(200, b'{"status":"ready","profile":"private-synthetic"}')):
            self.assertTrue(health.ready('api'))
        with patch.object(health, 'exchange', side_effect=RuntimeError('CANARY_TOKEN')):
            self.assertFalse(health.ready('worker'))

    def test_scope_and_closed_payloads(self):
        metrics, logs = health.payloads('123', {'api': True, 'worker': False}, '2026-09-13T00:00:00Z')
        self.assertEqual(len(metrics['timeSeries']), 2)
        self.assertEqual([p['points'][0]['value']['doubleValue'] for p in metrics['timeSeries']], [1, 0])
        self.assertEqual(logs['entries'][1]['jsonPayload'], {'service': 'worker', 'code': 'RUNTIME_UNAVAILABLE'})
        for instance, states in [('CANARY_LOCATION', {'api': True, 'worker': False}),
                                  ('123', {'api': True, 'worker': False, 'CANARY_PHI': True}),
                                  ('123', {'api': 'CANARY_SECRET', 'worker': False})]:
            with self.assertRaises(ValueError):
                health.payloads(instance, states, '2026-09-13T00:00:00Z')
        self.assertNotIn('CANARY', json.dumps([metrics, logs]))

    def test_no_redirect(self):
        self.assertIsNone(health.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://example.invalid'))

    def test_expiry_makes_no_network_calls(self):
        with patch.object(health.datetime, 'datetime') as clock, patch.object(health, 'exchange') as network:
            clock.now.return_value = health.EXPIRY
            output = io.StringIO()
            with redirect_stdout(output):
                self.assertEqual(health.main(), 0)
            network.assert_not_called()
            self.assertEqual(output.getvalue(), 'TELEMETRY_WINDOW_EXPIRED\n')


if __name__ == '__main__':
    unittest.main()
