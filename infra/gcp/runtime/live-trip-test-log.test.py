import importlib.util
import json
import pathlib
import tempfile
import unittest

source=pathlib.Path(__file__).with_name('live-trip-test-log.py')
spec=importlib.util.spec_from_file_location('live_trip_test_log',source)
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class TripLoggerTest(unittest.TestCase):
    def test_query_is_scoped_and_excludes_location_and_rider_payloads(self):
        query=module.query_for_day('2026-09-24')
        self.assertIn("service_date='2026-09-24'::date",query)
        self.assertIn('driver_action_receipt',query)
        self.assertIn('location_batch_receipt',query)
        self.assertNotIn('ST_AsText',query)
        self.assertNotIn('synthetic_reference',query)
        with self.assertRaises(ValueError):module.query_for_day("2026-09-24'; DROP TABLE")

    def test_restart_deduplicates_events(self):
        events=[{'eventKey':'run:one','at':'2026-09-24T10:00:00Z','data':{'kind':'RUN_CREATED'}}]
        with tempfile.TemporaryDirectory() as directory:
            path=pathlib.Path(directory)/'log.jsonl'
            path.touch()
            seen=set()
            self.assertEqual(module.append_new(path,events,seen),1)
            self.assertEqual(module.append_new(path,events,seen),0)
            restored={json.loads(line)['eventKey'] for line in path.read_text().splitlines()}
            self.assertEqual(restored,seen)

    def test_report_uses_server_recorded_pickup_dropoff_and_gps_counts(self):
        events=[
            {'data':{'kind':'LEG_PLANNED','tripLegId':'leg','plannedPickupAt':'09:00','plannedDropoffAt':'10:00'}},
            {'data':{'kind':'DRIVER_ACTION','tripLegId':'leg','command':'ARRIVE_PICKUP','outcome':'APPLIED','recordedAt':'09:06'}},
            {'data':{'kind':'DRIVER_ACTION','tripLegId':'leg','command':'BOARD_RIDER','outcome':'APPLIED','recordedAt':'09:11'}},
            {'data':{'kind':'DRIVER_ACTION','tripLegId':'leg','command':'COMPLETE_LEG','outcome':'APPLIED','recordedAt':'10:03'}},
            {'data':{'kind':'GPS_BATCH','shiftId':'shift','sampleCount':3,'acceptedCount':2,'receivedAt':'09:05'}},
        ]
        summary=module.report(events)
        self.assertEqual(summary['legs']['leg']['pickupArrivalAt'],'09:06')
        self.assertEqual(summary['legs']['leg']['completedAt'],'10:03')
        self.assertEqual(summary['gpsByShift']['shift']['rejectedSamples'],1)

if __name__=='__main__':unittest.main()
