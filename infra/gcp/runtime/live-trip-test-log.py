"""Read-only, privacy-minimal trip timelines scoped to business tenants.

Run on the VM with: python3 live-trip-test-log.py --all
The file contains opaque IDs, event names, timestamps and GPS delivery metrics;
it never records rider names, addresses, raw coordinates or credentials.
"""
import argparse
from datetime import date, datetime, timedelta
import json
import os
import pathlib
import re
import sqlite3
import subprocess
import time
from zoneinfo import ZoneInfo

TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
POSTGRES = 'kavaroutes-cloud-postgres-1'
ADMIN_REPORTS = pathlib.Path('/var/lib/kavaroutes-admin/trip-reports')/TENANT
RAW_REPORTS = pathlib.Path('/var/lib/kavaroutes-site/diagnostics')
ADMIN_CONFIG = pathlib.Path('/var/lib/kavaroutes-admin/config.json')
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

def query_for_day(day,tenant=TENANT):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('SERVICE_DATE_INVALID')
    if not UUID.fullmatch(tenant):raise ValueError('TENANT_ID_INVALID')
    return f"""
WITH day_runs AS (
 SELECT tenant_id,id,service_date,created_at FROM dispatch.run
 WHERE tenant_id='{tenant}'::uuid AND service_date='{day}'::date
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

def collect(day,tenant=TENANT):
    result=subprocess.run(['docker','exec',POSTGRES,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                           '-U','kr_cloud_admin','-d','kavaroutes_cloud','-c',query_for_day(day,tenant)],
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

def local_time(value):
    if not value:return 'not recorded'
    instant=datetime.fromisoformat(value.replace('Z','+00:00'))
    return instant.astimezone(ZoneInfo('America/Los_Angeles')).strftime('%b %-d, %-I:%M:%S %p %Z')

def readable_report(events,day,generated_at=None):
    """Render a privacy-minimal timeline for an operator or plain-text email."""
    generated_at=generated_at or datetime.now(ZoneInfo('America/Los_Angeles'))
    summary=report(events)
    legs=summary['legs']
    actions=[event for event in events if event['data']['kind']=='DRIVER_ACTION']
    rejected=[event for event in actions if event['data']['outcome']=='REJECTED']
    gps=[event for event in events if event['data']['kind']=='GPS_BATCH']
    accepted=sum(event['data']['acceptedCount'] for event in gps)
    rejected_samples=sum(event['data']['sampleCount']-event['data']['acceptedCount'] for event in gps)
    lines=[f'KavaRoutes live trip test — {day} (Pacific time)',
           f'Generated: {generated_at.strftime("%b %-d, %-I:%M:%S %p %Z")}',
           f'Events: {len(events)} | Legs: {len(legs)} | Driver actions: {len(actions)} | Rejected actions: {len(rejected)}',
           f'GPS delivery: {accepted} accepted, {rejected_samples} rejected samples in {len(gps)} batches',
           '', 'TRIP LEGS']
    if not legs:lines.append('  No trip legs recorded yet.')
    for leg_id,leg in sorted(legs.items(),key=lambda item:item[1].get('plannedPickupAt') or ''):
        lines.extend([f'  Leg {leg_id[:8]}',
                      f'    Planned pickup: {local_time(leg.get("plannedPickupAt"))}',
                      f'    Pickup arrival: {local_time(leg.get("pickupArrivalAt"))}',
                      f'    Rider boarded: {local_time(leg.get("boardedAt"))}',
                      f'    Planned dropoff: {local_time(leg.get("plannedDropoffAt"))}',
                      f'    Dropoff arrival: {local_time(leg.get("dropoffArrivalAt"))}',
                      f'    Completed: {local_time(leg.get("completedAt"))}'])
    lines.extend(['', 'GPS BY SHIFT'])
    if not summary['gpsByShift']:lines.append('  No GPS batches received yet.')
    for shift_id,shift in summary['gpsByShift'].items():
        lines.append(f'  Shift {shift_id[:8]}: {shift["samples"]} accepted, {shift["rejectedSamples"]} rejected in {shift["batches"]} batches; last received {local_time(shift["lastReceivedAt"])}')
    lines.extend(['', 'TIMELINE (server receipt time unless stated)'])
    if not events:lines.append('  No events recorded yet.')
    gps_minutes={}
    timeline=[]
    for event in events:
        data=event['data']
        if data['kind']=='GPS_BATCH':
            minute=datetime.fromisoformat(event['at'].replace('Z','+00:00')).replace(second=0,microsecond=0).isoformat()
            bucket=gps_minutes.setdefault(minute,{'batches':0,'accepted':0,'rejected':0})
            bucket['batches']+=1
            bucket['accepted']+=data['acceptedCount']
            bucket['rejected']+=data['sampleCount']-data['acceptedCount']
            continue
        kind=data['kind']
        label={'RUN_CREATED':'Run created','LEG_PLANNED':'Leg planned',
               'ASSIGNMENT_CREATED':'Driver assigned','SHIFT_STARTED':'Shift started',
               'SERVICE_PROOF':'Service proof recorded','DRIVER_ACTION':'Driver action'}.get(kind,kind)
        if kind=='LEG_PLANNED':label+=f' {data["tripLegId"][:8]}'
        elif kind=='DRIVER_ACTION':
            label+=f' {data["command"]} — {data["outcome"]}'
            if data.get('reason'):label+=f' ({data["reason"]})'
            if data.get('capturedAt') and data['capturedAt']!=data.get('recordedAt'):
                label+=f'; phone captured {local_time(data["capturedAt"])}'
        elif kind=='SERVICE_PROOF':label+=f' {data["event"]}'
        timeline.append((datetime.fromisoformat(event['at'].replace('Z','+00:00')),f'  {local_time(event["at"])}  {label}'))
    for minute,bucket in gps_minutes.items():
        timeline.append((datetime.fromisoformat(minute),f'  {local_time(minute)}  GPS: {bucket["accepted"]} accepted, {bucket["rejected"]} rejected in {bucket["batches"]} batches'))
    lines.extend(line for _,line in sorted(timeline))
    lines.extend(['', 'Times are driver-reported actions accepted by the server, not GPS geofence detections.',
                  'This report omits rider names, addresses, coordinates, credentials, and signatures.'])
    return '\n'.join(lines)+'\n'

def publish_readable(events,day,directory=ADMIN_REPORTS):
    """Atomically expose only the redacted text report to the admin dashboard."""
    if not directory.parent.exists():
        grandparent=directory.parent.parent.stat()
        directory.parent.mkdir(mode=0o700)
        os.chown(directory.parent,grandparent.st_uid,grandparent.st_gid)
    parent=directory.parent.stat()
    directory.mkdir(mode=0o700,exist_ok=True)
    if (directory.stat().st_uid,directory.stat().st_gid)!=(parent.st_uid,parent.st_gid):
        os.chown(directory,parent.st_uid,parent.st_gid)
    os.chmod(directory,0o700)
    target=directory/f'trip-test-{day}.txt'
    temporary=directory/f'.trip-test-{day}.{os.getpid()}.tmp'
    try:
        descriptor=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(descriptor,'w',encoding='utf-8') as output:
            os.fchown(output.fileno(),parent.st_uid,parent.st_gid)
            output.write(readable_report(events,day))
            output.flush();os.fsync(output.fileno())
        os.replace(temporary,target)
    finally:
        temporary.unlink(missing_ok=True)
    return target

def raw_path(day,tenant):
    directory=RAW_REPORTS if tenant==TENANT else RAW_REPORTS/tenant
    directory.mkdir(mode=0o700,parents=True,exist_ok=True)
    return directory/f'trip-test-{day}.jsonl'

def enabled_tenants():
    config=json.loads(ADMIN_CONFIG.read_text())
    database=pathlib.Path(config['database'])
    connection=sqlite3.connect(f'file:{database}?mode=ro',uri=True)
    try:tenants=[row[0] for row in connection.execute('SELECT tenant_id FROM business_workspaces WHERE logging_enabled=1')]
    finally:connection.close()
    if any(not UUID.fullmatch(tenant) for tenant in tenants):raise ValueError('TENANT_ID_INVALID')
    return tenants

def poll_once(day,tenant,seen_by_file):
    query_for_day(day,tenant)
    path=raw_path(day,tenant)
    if not path.exists():
        descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.close(descriptor)
    if path not in seen_by_file:
        seen_by_file[path]={json.loads(line)['eventKey'] for line in path.read_text().splitlines() if line.strip()}
    count=append_new(path,collect(day,tenant),seen_by_file[path])
    destination=ADMIN_REPORTS.parent/tenant
    if count or not (destination/f'trip-test-{day}.txt').exists():
        publish_readable([json.loads(line) for line in path.read_text().splitlines() if line.strip()],day,destination)
    return count,len(seen_by_file[path])

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('day',nargs='?')
    parser.add_argument('--tenant',default=TENANT)
    parser.add_argument('--all',action='store_true')
    parser.add_argument('--once',action='store_true')
    parser.add_argument('--report',action='store_true')
    parser.add_argument('--readable',action='store_true')
    args=parser.parse_args()
    if args.all and (args.day or args.report or args.readable or args.tenant!=TENANT):
        parser.error('--all cannot be combined with a date, tenant, or report option')
    if not args.all and not args.day:parser.error('service date required unless --all is used')
    if not args.all:query_for_day(args.day,args.tenant)
    if args.report or args.readable:
        path=raw_path(args.day,args.tenant)
        events=[json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
        if args.readable:print(readable_report(events,args.day),end='')
        else:print(json.dumps(report(events),separators=(',',':')))
        return
    seen_by_file={}
    while True:
        try:
            if args.all:
                day=datetime.now(ZoneInfo('America/Los_Angeles')).date().isoformat()
                for tenant in enabled_tenants():poll_once(day,tenant,seen_by_file)
                if args.once:print(json.dumps({'day':day,'businesses':len(enabled_tenants())}));return
            else:
                count,total=poll_once(args.day,args.tenant,seen_by_file)
                if args.once:print(json.dumps({'day':args.day,'newEvents':count,'totalEvents':total}));return
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError,sqlite3.Error) as error:
            print(f'TRIP_LOG_POLL_FAILED:{type(error).__name__}',flush=True)
            if args.once:raise SystemExit(1)
        if not args.all and datetime.now(ZoneInfo('America/Los_Angeles')).date()>date.fromisoformat(args.day)+timedelta(days=1):
            return
        time.sleep(60)

if __name__=='__main__':main()
