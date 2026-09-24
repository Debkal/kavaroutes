import importlib.util
import json
import pathlib
import tempfile
import unittest
from datetime import datetime
from zoneinfo import ZoneInfo

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
        self.assertIn("tenant_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid",
                      module.query_for_day('2026-09-24','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
        with self.assertRaises(ValueError):module.query_for_day('2026-09-24','../another-business')

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

    def test_readable_report_shows_pacific_timeline_and_gps_without_private_location(self):
        events=[
            {'at':'2026-09-24T18:00:00+00:00','data':{'kind':'LEG_PLANNED','tripLegId':'leg-12345678',
             'plannedPickupAt':'2026-09-24T18:00:00+00:00','plannedDropoffAt':'2026-09-24T18:30:00+00:00'}},
            {'at':'2026-09-24T18:07:00+00:00','data':{'kind':'DRIVER_ACTION','tripLegId':'leg-12345678',
             'command':'ARRIVE_PICKUP','outcome':'APPLIED','recordedAt':'2026-09-24T18:07:00+00:00',
             'capturedAt':'2026-09-24T18:06:30+00:00','reason':None}},
            {'at':'2026-09-24T18:08:01+00:00','data':{'kind':'GPS_BATCH','shiftId':'shift-12345678',
             'sampleCount':3,'acceptedCount':2,'receivedAt':'2026-09-24T18:08:01+00:00'}},
            {'at':'2026-09-24T18:08:20+00:00','data':{'kind':'GPS_BATCH','shiftId':'shift-12345678',
             'sampleCount':2,'acceptedCount':2,'receivedAt':'2026-09-24T18:08:20+00:00'}},
        ]
        result=module.readable_report(events,'2026-09-24',datetime(2026,9,24,12,tzinfo=ZoneInfo('America/Los_Angeles')))
        self.assertIn('Pickup arrival: Sep 24, 11:07:00 AM PDT',result)
        self.assertIn('phone captured Sep 24, 11:06:30 AM PDT',result)
        self.assertIn('GPS: 4 accepted, 1 rejected in 2 batches',result)
        self.assertEqual(result.count('GPS: 4 accepted'),1)
        self.assertLess(result.index('Driver action ARRIVE_PICKUP'),result.index('GPS: 4 accepted'))
        self.assertNotIn('latitude',result)

    def test_published_report_is_private_and_replaces_previous_view(self):
        with tempfile.TemporaryDirectory() as root:
            directory=pathlib.Path(root)/'trip-reports'
            event={'at':'2026-09-24T17:00:00+00:00','data':{'kind':'RUN_CREATED'}}
            path=module.publish_readable([event],'2026-09-24',directory)
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(directory.stat().st_mode & 0o777,0o700)
            self.assertIn('Run created',path.read_text())
            module.publish_readable([],'2026-09-24',directory)
            self.assertIn('No events recorded yet.',path.read_text())

if __name__=='__main__':unittest.main()
