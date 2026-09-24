"""Read-only, privacy-minimal trip timelines scoped to business tenants.

Run on the VM with: python3 live-trip-test-log.py --all
The file contains opaque IDs, event names, timestamps and GPS delivery metrics;
it never records rider names, addresses, raw coordinates or credentials.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
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
REPORT_REVISION = '3'
UUID = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')

def query_for_day(day,tenant=TENANT):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
        raise ValueError('SERVICE_DATE_INVALID')
    if not UUID.fullmatch(tenant):raise ValueError('TENANT_ID_INVALID')
    return f"""
WITH day_runs AS (
 SELECT tenant_id,id,service_date,service_timezone,created_at FROM dispatch.run
 WHERE tenant_id='{tenant}'::uuid AND service_date='{day}'::date
), day_legs AS (
 SELECT rl.tenant_id,rl.run_id,rl.trip_leg_id FROM dispatch.run_leg rl
 JOIN day_runs r ON r.tenant_id=rl.tenant_id AND r.id=rl.run_id
), day_shifts AS (
 SELECT s.tenant_id,s.id,s.driver_id,s.assignment_id,s.pinned_at,r.service_date,r.service_timezone
 FROM execution.shift_policy_snapshot s JOIN dispatch.assignment a
 ON a.tenant_id=s.tenant_id AND a.id=s.assignment_id
 JOIN day_runs r ON r.tenant_id=a.tenant_id AND r.id=a.run_id
), events AS (
 SELECT 'run:'||r.id::text AS event_key,r.created_at AS event_at,
 jsonb_build_object('kind','RUN_CREATED','runId',r.id,'serviceDate',r.service_date) AS payload
 FROM day_runs r
 UNION ALL
 SELECT 'timezone:'||r.id::text,r.created_at,
 jsonb_build_object('kind','RUN_TIMEZONE','runId',r.id,'serviceTimezone',r.service_timezone)
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
 SELECT 'route:'||sr.trip_leg_id::text||':'||sr.version::text,sr.selected_at,
 jsonb_build_object('kind','ROAD_ROUTE_SELECTED','runId',dl.run_id,'tripLegId',sr.trip_leg_id,
  'goal',sr.goal,'version',sr.version)
 FROM dispatch.selected_road_route sr JOIN day_legs dl
 ON dl.tenant_id=sr.tenant_id AND dl.trip_leg_id=sr.trip_leg_id
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
 SELECT 'alert:'||a.shift_id::text||':'||a.version::text,a.evaluated_at,
 jsonb_build_object('kind','TRACKING_ALERT','shiftId',a.shift_id,'status',a.status,
  'reason',a.reason,'contactDriver',a.contact_driver,'lastReceivedAt',a.last_received_at)
 FROM execution.driver_tracking_alert_event a JOIN day_shifts s ON s.tenant_id=a.tenant_id AND s.id=a.shift_id
 UNION ALL
 SELECT 'closure:'||c.command_id::text,c.recorded_at,
 jsonb_build_object('kind','SHIFT_CLOSURE','shiftId',c.shift_id,'closureKind',c.kind,
  'returnResult',c.return_result,'reason',c.reason_code)
 FROM execution.driver_shift_closure c JOIN day_shifts s ON s.tenant_id=c.tenant_id AND s.id=c.shift_id
 UNION ALL
 SELECT 'gps:'||b.id::text,b.received_at,
 jsonb_build_object('kind','GPS_BATCH','shiftId',b.shift_id,'sampleCount',b.sample_count,
  'acceptedCount',count(g.id),'firstCapturedAt',min(g.captured_at),'lastCapturedAt',max(g.captured_at),
  'maxAccuracyMeters',max(g.accuracy_meters),'receivedAt',b.received_at)
 FROM realtime.location_batch_receipt b JOIN day_shifts s ON s.tenant_id=b.tenant_id AND s.id=b.shift_id
 LEFT JOIN realtime.location_breadcrumb g ON g.tenant_id=b.tenant_id AND g.batch_id=b.id
 WHERE (b.received_at AT TIME ZONE s.service_timezone)::date=s.service_date
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

def current_service_days(tenant):
    if not UUID.fullmatch(tenant):raise ValueError('TENANT_ID_INVALID')
    query=("SELECT DISTINCT service_date FROM dispatch.run "
           f"WHERE tenant_id='{tenant}'::uuid "
           "AND service_date BETWEEN (now() AT TIME ZONE service_timezone)::date-1 "
           "AND (now() AT TIME ZONE service_timezone)::date")
    result=subprocess.run(['docker','exec',POSTGRES,'psql','-X','-q','-A','-t','-v','ON_ERROR_STOP=1',
                           '-U','kr_cloud_admin','-d','kavaroutes_cloud','-c',query],
                          capture_output=True,text=True,timeout=20,check=True)
    return [day for day in result.stdout.splitlines() if re.fullmatch(r'\d{4}-\d{2}-\d{2}',day)]

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

def report(events,day=None):
    legs={}
    shifts={}
    action_names={'ARRIVE_PICKUP':'pickupArrivalAt','BOARD_RIDER':'boardedAt',
                  'ARRIVE_DROPOFF':'dropoffArrivalAt','COMPLETE_LEG':'completedAt'}
    day_gps={id(event) for event in service_day_gps(events,day,event_timezones(events))} if day else None
    for event in events:
        data=event['data']
        kind=data['kind']
        if kind=='GPS_BATCH' and day_gps is not None and id(event) not in day_gps:continue
        if kind=='LEG_PLANNED':
            legs.setdefault(data['tripLegId'],{}).update({'plannedPickupAt':data['plannedPickupAt'],
                                                           'plannedDropoffAt':data['plannedDropoffAt']})
        elif kind=='ROAD_ROUTE_SELECTED':
            leg=legs.setdefault(data['tripLegId'],{})
            if data['version']>=leg.get('routeVersion',0):
                leg['routeGoal']=data['goal'];leg['routeVersion']=data['version']
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

def local_time(value,zone='UTC'):
    if not value:return 'not recorded'
    instant=datetime.fromisoformat(value.replace('Z','+00:00'))
    return instant.astimezone(ZoneInfo(zone)).strftime('%b %-d, %-I:%M:%S %p %Z')

def event_timezones(events):
    runs={event['data']['runId']:event['data']['serviceTimezone'] for event in events
          if event['data']['kind']=='RUN_TIMEZONE'}
    legs={event['data']['tripLegId']:event['data']['runId'] for event in events
          if event['data']['kind']=='LEG_PLANNED'}
    assignments={event['data']['assignmentId']:event['data']['runId'] for event in events
                 if event['data']['kind']=='ASSIGNMENT_CREATED'}
    shifts={event['data']['shiftId']:assignments.get(event['data']['assignmentId']) for event in events
            if event['data']['kind']=='SHIFT_STARTED'}
    def zone(event):
        data=event['data']
        run_id=data.get('runId') or legs.get(data.get('tripLegId')) or shifts.get(data.get('shiftId'))
        return runs.get(run_id,'UTC')
    return zone

def service_day_gps(events,day,zone_for):
    """The archive is append-only, so also filter old batches collected before this fix."""
    included=[]
    for event in events:
        if event['data']['kind']!='GPS_BATCH':continue
        received=event['data'].get('receivedAt') or event.get('at')
        if not received:continue
        instant=datetime.fromisoformat(received.replace('Z','+00:00'))
        if instant.astimezone(ZoneInfo(zone_for(event))).date().isoformat()==day:
            included.append(event)
    return included

def duration_text(start,end):
    seconds=max(0,round((datetime.fromisoformat(end.replace('Z','+00:00'))-
                         datetime.fromisoformat(start.replace('Z','+00:00'))).total_seconds()))
    return f'{seconds//60}m {seconds%60}s'

def alert_interval(start,end,day,zone_for):
    """Return a service-day slice of an alert, retaining its overnight context."""
    zone=ZoneInfo(zone_for(start))
    boundary=datetime.fromisoformat(f'{day}T00:00:00').replace(tzinfo=zone)
    end_boundary=datetime.combine(date.fromisoformat(day)+timedelta(days=1),datetime.min.time(),zone)
    finish=datetime.fromisoformat(end['at'].replace('Z','+00:00'))
    began=datetime.fromisoformat(start['at'].replace('Z','+00:00'))
    if finish<=boundary or began>=end_boundary:return None
    effective=max(began,boundary)
    visible_end=min(finish,end_boundary)
    carried=began<boundary
    ending=f'resolved as {end["data"]["status"]}' if finish<=end_boundary else 'continued after this service date'
    return f'{local_time(effective.isoformat(),zone.key)} → {local_time(visible_end.isoformat(),zone.key)} ({duration_text(effective.isoformat(),visible_end.isoformat())}); {ending}' + ('; carried over from the previous day.' if carried else '.')

def readable_report(events,day,generated_at=None):
    """Render a privacy-minimal timeline for an operator or plain-text email."""
    generated_at=generated_at or datetime.now(timezone.utc)
    if generated_at.tzinfo is None:raise ValueError('GENERATED_AT_REQUIRES_TIMEZONE')
    zone_for=event_timezones(events)
    gps=service_day_gps(events,day,zone_for)
    summary=report(events,day)
    legs=summary['legs']
    leg_zones={event['data']['tripLegId']:zone_for(event) for event in events
               if event['data']['kind']=='LEG_PLANNED'}
    shift_zones={event['data']['shiftId']:zone_for(event) for event in events
                 if event['data']['kind']=='SHIFT_STARTED'}
    actions=[event for event in events if event['data']['kind']=='DRIVER_ACTION']
    rejected=[event for event in actions if event['data']['outcome']=='REJECTED']
    alerts=sorted((event for event in events if event['data']['kind']=='TRACKING_ALERT'),key=lambda event:event['at'])
    closures=[event for event in events if event['data']['kind']=='SHIFT_CLOSURE']
    accepted=sum(event['data']['acceptedCount'] for event in gps)
    rejected_samples=sum(event['data']['sampleCount']-event['data']['acceptedCount'] for event in gps)
    lines=[f'KavaRoutes live trip test — service date {day}',
           f'Report revision: {REPORT_REVISION}',
           f'Generated: {generated_at.astimezone(timezone.utc).strftime("%b %-d, %-I:%M:%S %p UTC")}',
           'Trip times use each run\'s service timezone; UTC means the saved timezone was unavailable.',
           f'Archived run/shift events: {len(events)} | Legs: {len(legs)} | Driver actions: {len(actions)} | Rejected actions: {len(rejected)}',
           f'GPS delivery on service date: {accepted} accepted, {rejected_samples} rejected samples in {len(gps)} batches',
           '', 'TRIP LEGS']
    if not legs:lines.append('  No trip legs recorded yet.')
    for leg_id,leg in sorted(legs.items(),key=lambda item:item[1].get('plannedPickupAt') or ''):
        zone=leg_zones.get(leg_id,'UTC')
        lines.extend([f'  Leg {leg_id[:8]} — {zone}',
                      f'    Planned pickup: {local_time(leg.get("plannedPickupAt"),zone)}',
                      f'    Pickup arrival: {local_time(leg.get("pickupArrivalAt"),zone)}',
                      f'    Rider boarded: {local_time(leg.get("boardedAt"),zone)}',
                      f'    Planned dropoff: {local_time(leg.get("plannedDropoffAt"),zone)}',
                      f'    Dropoff arrival: {local_time(leg.get("dropoffArrivalAt"),zone)}',
                      f'    Completed: {local_time(leg.get("completedAt"),zone)}',
                      f'    Driver road route: {leg.get("routeGoal","not selected in Dispatch")}'])
    lines.extend(['', 'GPS BY SHIFT'])
    if not summary['gpsByShift']:lines.append('  No GPS batches received yet.')
    for shift_id,shift in summary['gpsByShift'].items():
        zone=shift_zones.get(shift_id,'UTC')
        lines.append(f'  Shift {shift_id[:8]} ({zone}): {shift["samples"]} accepted, {shift["rejectedSamples"]} rejected in {shift["batches"]} batches; last received {local_time(shift["lastReceivedAt"],zone)}')
    lines.extend(['', 'TRACKING ALERTS ON SERVICE DATE'])
    alert_lines=[]
    overdue={}
    for event in alerts:
        data=event['data'];shift_id=data['shiftId'];status=data['status']
        if status=='UPDATES_OVERDUE':overdue.setdefault(shift_id,event)
        elif shift_id in overdue:
            start=overdue.pop(shift_id)
            interval=alert_interval(start,event,day,zone_for)
            if interval:alert_lines.append(f'  Shift {shift_id[:8]}: updates overdue {interval}')
    for shift_id,start in overdue.items():
        zone=ZoneInfo(zone_for(start))
        boundary=datetime.fromisoformat(f'{day}T00:00:00').replace(tzinfo=zone)
        began=datetime.fromisoformat(start['at'].replace('Z','+00:00'))
        if began.astimezone(zone).date().isoformat()<=day:
            alert_lines.append(f'  Shift {shift_id[:8]}: updates overdue since {local_time(max(began,boundary).isoformat(),zone.key)}; no recovery recorded.'
                               + (' Carried over from the previous day.' if began<boundary else ''))
    lines.extend(alert_lines or ['  No overdue tracking intervals on this service date.'])
    lines.append('  Alert durations measure the overdue state, not an exact GPS blackout; the cause is not recorded.')
    lines.extend(['', 'SHIFT CLOSURE'])
    if not closures:lines.append('  No shift closure recorded yet.')
    for event in sorted(closures,key=lambda item:item['at']):
        data=event['data'];kind=data['closureKind']
        label='Driver requested return review' if kind=='RETURN_EXCEPTION' else 'Dispatch approved return exception' if kind=='DISPATCH_OVERRIDE' else kind.replace('_',' ').title()
        lines.append(f'  Shift {data["shiftId"][:8]}: {label} at {local_time(event["at"],zone_for(event))}; return {data["returnResult"]}; reason {data["reason"]}.')
    lines.extend(['', 'TIMELINE (server receipt time unless stated)'])
    if not events:lines.append('  No events recorded yet.')
    gps_minutes={}
    timeline=[]
    gps_keys={event['eventKey'] for event in gps if 'eventKey' in event}
    for event in events:
        data=event['data']
        if data['kind']=='GPS_BATCH':
            if 'eventKey' in event and event['eventKey'] not in gps_keys:continue
            if 'eventKey' not in event and event not in gps:continue
            minute=datetime.fromisoformat(event['at'].replace('Z','+00:00')).replace(second=0,microsecond=0).isoformat()
            bucket=gps_minutes.setdefault((minute,data['shiftId']),{'batches':0,'accepted':0,'rejected':0,'event':event})
            bucket['batches']+=1
            bucket['accepted']+=data['acceptedCount']
            bucket['rejected']+=data['sampleCount']-data['acceptedCount']
            continue
        kind=data['kind']
        label={'RUN_CREATED':'Run created','RUN_TIMEZONE':'Service timezone recorded','LEG_PLANNED':'Scheduled pickup',
               'ASSIGNMENT_CREATED':'Driver assigned','SHIFT_STARTED':'Shift started',
               'SERVICE_PROOF':'Service proof recorded','DRIVER_ACTION':'Driver action',
               'ROAD_ROUTE_SELECTED':'Driver road route selected','TRACKING_ALERT':'Tracking alert',
               'SHIFT_CLOSURE':'Shift closure'}.get(kind,kind)
        if kind=='RUN_TIMEZONE':label+=f' {data["serviceTimezone"]}'
        elif kind=='LEG_PLANNED':label+=f' {data["tripLegId"][:8]}'
        elif kind=='DRIVER_ACTION':
            label+=f' {data["command"]} — {data["outcome"]}'
            if data.get('reason'):label+=f' ({data["reason"]})'
            if data.get('capturedAt') and data['capturedAt']!=data.get('recordedAt'):
                label+=f'; phone captured {local_time(data["capturedAt"],zone_for(event))}'
        elif kind=='SERVICE_PROOF':label+=f' {data["event"]}'
        elif kind=='ROAD_ROUTE_SELECTED':label+=f' {data["goal"]} for leg {data["tripLegId"][:8]}'
        elif kind=='TRACKING_ALERT':label+=f' {data["status"]} ({data["reason"]})'
        elif kind=='SHIFT_CLOSURE':label+=f' {data["closureKind"]} — {data["returnResult"]} ({data["reason"]})'
        timeline.append((datetime.fromisoformat(event['at'].replace('Z','+00:00')),f'  {local_time(event["at"],zone_for(event))}  {label}'))
    for (minute,_),bucket in gps_minutes.items():
        timeline.append((datetime.fromisoformat(minute),f'  {local_time(minute,zone_for(bucket["event"]))}  GPS: {bucket["accepted"]} accepted, {bucket["rejected"]} rejected in {bucket["batches"]} batches'))
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
    target=destination/f'trip-test-{day}.txt'
    if count or not target.exists() or f'Report revision: {REPORT_REVISION}' not in target.read_text(encoding='utf-8'):
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
        else:print(json.dumps(report(events,args.day),separators=(',',':')))
        return
    seen_by_file={}
    while True:
        try:
            if args.all:
                tenants=enabled_tenants()
                for tenant in tenants:
                    for day in current_service_days(tenant):poll_once(day,tenant,seen_by_file)
                if args.once:print(json.dumps({'businesses':len(tenants)}));return
            else:
                count,total=poll_once(args.day,args.tenant,seen_by_file)
                if args.once:print(json.dumps({'day':args.day,'newEvents':count,'totalEvents':total}));return
        except (subprocess.CalledProcessError,subprocess.TimeoutExpired,ValueError,OSError,sqlite3.Error) as error:
            print(f'TRIP_LOG_POLL_FAILED:{type(error).__name__}',flush=True)
            if args.once:raise SystemExit(1)
        if not args.all and datetime.now(timezone.utc).date()>date.fromisoformat(args.day)+timedelta(days=2):
            return
        time.sleep(60)

if __name__=='__main__':main()
