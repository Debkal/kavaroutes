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
        self.assertIn('driver_tracking_alert_event',query)
        self.assertIn('driver_shift_closure',query)
        self.assertIn('selected_road_route',query)
        self.assertIn('(b.received_at AT TIME ZONE s.service_timezone)::date=s.service_date',query)
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

    def test_readable_report_uses_saved_run_timezone_and_omits_private_location(self):
        events=[
            {'at':'2026-09-24T17:00:00+00:00','data':{'kind':'RUN_TIMEZONE','runId':'run-12345678','serviceTimezone':'America/Los_Angeles'}},
            {'at':'2026-09-24T17:00:00+00:00','data':{'kind':'ASSIGNMENT_CREATED','runId':'run-12345678','assignmentId':'assignment-12345678'}},
            {'at':'2026-09-24T17:00:00+00:00','data':{'kind':'SHIFT_STARTED','assignmentId':'assignment-12345678','shiftId':'shift-12345678'}},
            {'at':'2026-09-24T18:00:00+00:00','data':{'kind':'LEG_PLANNED','runId':'run-12345678','tripLegId':'leg-12345678',
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
        self.assertIn('Leg leg-1234 — America/Los_Angeles',result)
        self.assertIn('Shift shift-12 (America/Los_Angeles)',result)
        self.assertIn('phone captured Sep 24, 11:06:30 AM PDT',result)
        self.assertIn('GPS: 4 accepted, 1 rejected in 2 batches',result)
        self.assertEqual(result.count('GPS: 4 accepted'),1)
        self.assertLess(result.index('Driver action ARRIVE_PICKUP'),result.index('GPS: 4 accepted'))
        self.assertNotIn('latitude',result)

    def test_readable_report_handles_different_run_zones_on_same_service_day(self):
        events=[
            {'at':'2026-09-24T12:00:00Z','data':{'kind':'RUN_TIMEZONE','runId':'east','serviceTimezone':'America/New_York'}},
            {'at':'2026-09-24T12:00:00Z','data':{'kind':'RUN_TIMEZONE','runId':'west','serviceTimezone':'America/Los_Angeles'}},
            {'at':'2026-09-24T16:00:00Z','data':{'kind':'LEG_PLANNED','runId':'east','tripLegId':'east-leg',
             'plannedPickupAt':'2026-09-24T16:00:00Z','plannedDropoffAt':'2026-09-24T16:30:00Z'}},
            {'at':'2026-09-24T16:00:00Z','data':{'kind':'LEG_PLANNED','runId':'west','tripLegId':'west-leg',
             'plannedPickupAt':'2026-09-24T16:00:00Z','plannedDropoffAt':'2026-09-24T16:30:00Z'}},
        ]
        result=module.readable_report(events,'2026-09-24')
        self.assertIn('Leg east-leg — America/New_York\n    Planned pickup: Sep 24, 12:00:00 PM EDT',result)
        self.assertIn('Leg west-leg — America/Los_Angeles\n    Planned pickup: Sep 24, 9:00:00 AM PDT',result)
        self.assertIn('Scheduled pickup east-leg',result)

    def test_daily_report_excludes_archived_prior_day_gps_and_shows_outages_and_closure(self):
        events=[
            {'eventKey':'timezone:run','at':'2026-09-24T12:00:00Z','data':{'kind':'RUN_TIMEZONE','runId':'run','serviceTimezone':'America/Chicago'}},
            {'eventKey':'assignment:a','at':'2026-09-24T12:00:00Z','data':{'kind':'ASSIGNMENT_CREATED','runId':'run','assignmentId':'assignment'}},
            {'eventKey':'shift:s','at':'2026-09-24T12:00:00Z','data':{'kind':'SHIFT_STARTED','assignmentId':'assignment','shiftId':'shift-12345678'}},
            {'eventKey':'leg:l','at':'2026-09-24T14:00:00Z','data':{'kind':'LEG_PLANNED','runId':'run','tripLegId':'leg-12345678','plannedPickupAt':'2026-09-24T14:00:00Z','plannedDropoffAt':'2026-09-24T15:00:00Z'}},
            {'eventKey':'gps:old','at':'2026-09-23T22:00:00Z','data':{'kind':'GPS_BATCH','shiftId':'shift-12345678','sampleCount':145,'acceptedCount':145,'receivedAt':'2026-09-23T22:00:00Z'}},
            {'eventKey':'gps:today','at':'2026-09-24T17:00:00Z','data':{'kind':'GPS_BATCH','shiftId':'shift-12345678','sampleCount':2,'acceptedCount':1,'receivedAt':'2026-09-24T17:00:00Z'}},
            {'eventKey':'route:l:1','at':'2026-09-24T13:00:00Z','data':{'kind':'ROAD_ROUTE_SELECTED','runId':'run','tripLegId':'leg-12345678','goal':'LOW_COST','version':1}},
            {'eventKey':'alert:s:1','at':'2026-09-24T17:01:00Z','data':{'kind':'TRACKING_ALERT','shiftId':'shift-12345678','status':'UPDATES_OVERDUE','reason':'NO_RECENT_UPDATE_UNKNOWN_CAUSE','contactDriver':True}},
            {'eventKey':'alert:s:2','at':'2026-09-24T17:19:41Z','data':{'kind':'TRACKING_ALERT','shiftId':'shift-12345678','status':'UPDATES_CURRENT','reason':'RECENT_SAMPLE_RECEIVED','contactDriver':False}},
            {'eventKey':'closure:review','at':'2026-09-24T17:37:51Z','data':{'kind':'SHIFT_CLOSURE','shiftId':'shift-12345678','closureKind':'RETURN_EXCEPTION','returnResult':'UNAVAILABLE','reason':'NORMAL_SIGN_OFF'}},
            {'eventKey':'closure:approved','at':'2026-09-24T17:39:04Z','data':{'kind':'SHIFT_CLOSURE','shiftId':'shift-12345678','closureKind':'DISPATCH_OVERRIDE','returnResult':'OVERRIDDEN','reason':'RETURN_EXCEPTION_REVIEWED'}},
        ]
        result=module.readable_report(events,'2026-09-24')
        self.assertIn('GPS delivery on service date: 1 accepted, 1 rejected samples in 1 batches',result)
        self.assertIn('Driver road route: LOW_COST',result)
        self.assertIn('18m 41s',result)
        self.assertIn('Driver requested return review',result)
        self.assertIn('Dispatch approved return exception',result)
        self.assertNotIn('GPS: 145 accepted',result)

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
