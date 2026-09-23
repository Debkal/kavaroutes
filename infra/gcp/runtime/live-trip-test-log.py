"""Read-only, privacy-minimal live trip timeline for one synthetic service day.

Run on the VM with: python3 live-trip-test-log.py 2026-09-24 [--once]
The file contains opaque IDs, event names, timestamps and GPS delivery metrics;
it never records rider names, addresses, raw coordinates or credentials.
"""
import argparse
from datetime import date, datetime, timedelta
import json
import os
import pathlib
import re
import subprocess
import time
from zoneinfo import ZoneInfo

TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
POSTGRES = 'kavaroutes-cloud-postgres-1'

def query_for_day(day):
    if not re.fullmatch(r'2026-\d{2}-\d{2}', day):
        raise ValueError('SERVICE_DATE_INVALID')
    return f"""
WITH day_runs AS (
 SELECT tenant_id,id,service_date,created_at FROM dispatch.run
 WHERE tenant_id='{TENANT}'::uuid AND service_date='{day}'::date
), day_legs AS (
 SELECT rl.tenant_id,rl.run_id,rl.trip_leg_id FROM dispatch.run_leg rl
 JOIN day_runs r ON r.tenant_id=rl.tenant_id AND r.id=rl.run_id
), day_shifts AS (
 SELECT s.tenant_id,s.id,s.driver_id,s.assignment_id,s.pinned_at
 FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a
 ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
 JOIN day_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
), events AS (
 SELECT 'run:'||r.id::text AS event_key,r.created_at AS event_at,
 jsonb_build_object('kind','RUN_CREATED','runId',r.id,'serviceDate',r.service_date) AS payload
 FROM day_runs r
 UNION ALL
 SELECT 'leg:'||l.trip_leg_id::text,l.planned_start_at,
 jsonb_build_object('kind','LEG_PLANNED','runId',l.run_id,'tripLegId',l.trip_leg_id,
  'plannedPickupAt',l.planned_start_at,'plannedDropoffAt',l.planned_end_at)
 FROM (
  SELECT dl.run_id,dl.trip_leg_id,t.planned_start_at,t.planned_end_at
  FROM day_legs dl JOIN intake.trip_leg t ON t.tenant_id=dl.tenant_id AND t.id=dl.trip_leg_id
 ) l
 UNION ALL
 SELECT 'assignment:'||a.id::text,a.created_at,
 jsonb_build_object('kind','ASSIGNMENT_CREATED','runId',a.run_id,'assignmentId',a.id,'driverId',a.driver_id)
 FROM dispatch.assignment a JOIN day_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
 UNION ALL
 SELECT 'shift:'||s.id::text,s.pinned_at,
 jsonb_build_object('kind','SHIFT_STARTED','shiftId',s.id,'assignmentId',s.assignment_id,'driverId',s.driver_id)
 FROM day_shifts s
 UNION ALL
 SELECT 'action:'||a.client_action_id::text,a.recorded_at,
 jsonb_build_object('kind','DRIVER_ACTION','shiftId',a.shift_id,'tripLegId',a.resource_reference,
  'command',a.command_reference,'outcome',a.outcome,'reason',a.reason_code,
  'capturedAt',a.captured_at,'recordedAt',a.recorded_at)
 FROM execution.driver_action_receipt a JOIN day_shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
 UNION ALL
 SELECT 'proof:'||p.evidence_id::text,p.recorded_at,
 jsonb_build_object('kind','SERVICE_PROOF','shiftId',p.shift_id,'event',p.event,'recordedAt',p.recorded_at)
 FROM execution.driver_service_proof p JOIN day_shifts s ON s.tenant_id=p.tenant_id AND s.id=p.shift_id
 UNION ALL
 SELECT 'gps:'||b.id::text,b.received_at,
 jsonb_build_object('kind','GPS_BATCH','shiftId',b.shift_id,'sampleCount',b.sample_count,
  'acceptedCount',count(g.id),'firstCapturedAt',min(g.captured_at),'lastCapturedAt',max(g.captured_at),
  'maxAccuracyMeters',max(g.accuracy_meters),'receivedAt',b.received_at)
 FROM realtime.location_batch_receipt b JOIN day_shifts s ON s.tenant_id=b.tenant_id AND s.id=b.shift_id
 LEFT JOIN realtime.location_breadcrumb g ON g.tenant_id=b.tenant_id AND g.batch_id=b.id
 GROUP BY b.tenant_id,b.id,b.shift_id,b.sample_count,b.received_at
)
SELECT jsonb_build_object('eventKey',event_key,'at',event_at,'data',payload)::text
FROM events ORDER BY event_at,event_key;
"""

def collect(day):
    result=subprocess.run(['docker','exec',POSTGRES,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                           '-U','kr_cloud_admin','-d','kavaroutes_cloud','-c',query_for_day(day)],
                          capture_output=True,text=True,timeout=20,check=True)
    return [json.loads(line) for line in result.stdout.splitlines() if line.strip()]

def append_new(path,events,seen):
    new=[event for event in events if event['eventKey'] not in seen]
    if not new:return 0
    with path.open('a',encoding='utf-8') as output:
        for event in new:
            output.write(json.dumps(event,separators=(',',':'))+'\n')
            seen.add(event['eventKey'])
        output.flush()
        os.fsync(output.fileno())
    return len(new)

def report(events):
    legs={}
    shifts={}
    action_names={'ARRIVE_PICKUP':'pickupArrivalAt','BOARD_RIDER':'boardedAt',
                  'ARRIVE_DROPOFF':'dropoffArrivalAt','COMPLETE_LEG':'completedAt'}
    for event in events:
        data=event['data']
        kind=data['kind']
        if kind=='LEG_PLANNED':
            legs[data['tripLegId']]={'plannedPickupAt':data['plannedPickupAt'],
                                      'plannedDropoffAt':data['plannedDropoffAt']}
        elif kind=='DRIVER_ACTION':
            leg=legs.setdefault(data['tripLegId'],{})
            if data['outcome']=='APPLIED' and data['command'] in action_names:
                leg[action_names[data['command']]]=data['recordedAt']
            elif data['outcome']=='REJECTED':
                leg.setdefault('rejectedActions',[]).append({'command':data['command'],
                                                            'reason':data['reason'],'at':data['recordedAt']})
        elif kind=='GPS_BATCH':
            shift=shifts.setdefault(data['shiftId'],{'batches':0,'samples':0,'rejectedSamples':0,
                                                      'lastReceivedAt':None})
            shift['batches']+=1
            shift['samples']+=data['acceptedCount']
            shift['rejectedSamples']+=data['sampleCount']-data['acceptedCount']
            shift['lastReceivedAt']=data['receivedAt']
    return {'legs':legs,'gpsByShift':shifts,'eventCount':len(events)}

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('day')
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--report',action='store_true')
    args=parser.parse_args()
    query_for_day(args.day)
    directory=pathlib.Path('/var/lib/kavaroutes-site/diagnostics')
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    path=directory/f'trip-test-{args.day}.jsonl'
    if args.report:
        events=[json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        print(json.dumps(report(events),separators=(',',':')))
        return
    if not path.exists():
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.close(descriptor)
    seen={json.loads(line)['eventKey'] for line in path.read_text().splitlines() if line.strip()}
    while True:
        try:
            count=append_new(path,collect(args.day),seen)
            if args.once:print(json.dumps({'day':args.day,'newEvents':count,'totalEvents':len(seen)}));return
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError) as error:
            print(f'TRIP_LOG_POLL_FAILED:{type(error).__name__}',flush=True)
            if args.once:raise SystemExit(1)
        if datetime.now(ZoneInfo('America/Los_Angeles')).date()>date.fromisoformat(args.day)+timedelta(days=1):
            return
        time.sleep(10)

if __name__=='__main__':main()
