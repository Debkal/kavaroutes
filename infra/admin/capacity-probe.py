"""Bounded read-only origin benchmark. No new cloud resources or provider calls.
Run on the existing VM with --run. Reports aggregate timings, never response data.
This measures one synthetic tenant, not 100-tenant production acceptance.
"""
import concurrent.futures as futures
import datetime
import http.client
import json
import os
import pathlib
import statistics
import sys
import threading
import time

PREFIX='/v1/organizations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
ROUTES=[('trips',PREFIX+'/trips?limit=50','dispatcher'),
        ('invoices',PREFIX+'/billing/invoices?limit=50','billing'),
        ('itinerary',PREFIX+'/driver/itineraries/2026-09-21','driver'),
        ('snapshot',PREFIX+'/runtime-dispatch-snapshot?serviceDate=2026-09-21','dispatcher')]
thread=threading.local()
def get(route):
    start=time.monotonic()
    try:
        if not hasattr(thread,'connection'): thread.connection=http.client.HTTPConnection('127.0.0.1',58080,timeout=3)
        thread.connection.request('GET',route[1],headers={'Authorization':'Synthetic principal_'+route[2]})
        response=thread.connection.getresponse(); data=response.read(2_000_001)
        status=response.status
        if len(data)>2_000_000: status=599
        return status,(time.monotonic()-start)*1000,len(data)
    except Exception:
        if hasattr(thread,'connection'): thread.connection.close();del thread.connection
        return 599,(time.monotonic()-start)*1000,0
def memory():
    rows=dict(line.split(':',1) for line in pathlib.Path('/proc/meminfo').read_text().splitlines())
    return int(rows['MemAvailable'].split()[0])//1024
def percentile(items,p): return sorted(items)[min(len(items)-1,int(len(items)*p))] if items else None
def main():
    if sys.argv[1:] not in [['--run'],['--confirm-25']]: raise SystemExit('Explicit --run or --confirm-25 required')
    confirmation=sys.argv[1]=='--confirm-25'
    preflight=[]
    for route in ROUTES:
        status,ms,size=get(route);preflight.append({'route':route[0],'status':status,'bytes':size})
    report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'VM loopback gateway, existing synthetic tenant, GET only; excludes Cloudflare/TLS, writes, GPS ingest, live Maps and 100-tenant data sizes','preflight':preflight,'stages':[]}
    if any(row['status']!=200 for row in preflight):
        print(json.dumps(report));raise SystemExit('PREFLIGHT_FAILED_NO_LOAD_SENT')
    with futures.ThreadPoolExecutor(max_workers=24) as pool:
        # Each level lasts 30 seconds; highest passing stage gets 120s confirmation.
        levels=[25] if confirmation else [5,10,25,50,100]; last=None
        for index in range(1 if confirmation else 6):
            target=levels[index] if index<5 else last
            if not target: break
            duration=180 if confirmation else (30 if index<5 else 120)
            start=time.monotonic(); pending=set(); results=[]; issued=0; dropped=0; stop=None; samples=[]
            while time.monotonic()-start<duration:
                elapsed=time.monotonic()-start
                due=start+issued/target
                if time.monotonic()<due: time.sleep(min(0.01,due-time.monotonic()));continue
                for future in list(pending):
                    if future.done(): results.append(future.result());pending.remove(future)
                if len(pending)>=48: dropped+=1
                else: pending.add(pool.submit(get,ROUTES[issued%len(ROUTES)]))
                issued+=1
                if issued%target==0:
                    samples.append({'availableMiB':memory(),'load1':os.getloadavg()[0]})
                    if samples[-1]['availableMiB']<384: stop='LOW_MEMORY';break
                    recent=results[-target*3:]
                    if len(recent)>=target and (sum(r[0]!=200 for r in recent)/len(recent)>0.02 or percentile([r[1] for r in recent],.95)>1000): stop='LATENCY_OR_ERRORS';break
            for future in pending: results.append(future.result())
            elapsed=time.monotonic()-start
            good=sum(r[0]==200 for r in results);latencies=[r[1] for r in results]
            result={'targetRps':target,'durationSeconds':round(elapsed,2),'confirmation':confirmation or index==5,'requests':len(results),'successfulRps':round(good/elapsed,2),'errorCount':len(results)-good,'schedulerDrops':dropped,'p50Ms':round(percentile(latencies,.5),2),'p95Ms':round(percentile(latencies,.95),2),'p99Ms':round(percentile(latencies,.99),2),'minAvailableMiB':min(s['availableMiB'] for s in samples),'maxLoad1':max(s['load1'] for s in samples),'stop':stop}
            report['stages'].append(result); print(json.dumps({'stage':result}),flush=True)
            passed=not stop and not dropped and good/len(results)>=.99 and result['p95Ms']<500
            if not passed: break
            last=target
            time.sleep(3)
    report['highestPassingReadRps']=last
    pathlib.Path('/tmp/kavaroutes-capacity-confirmation.json' if confirmation else '/tmp/kavaroutes-capacity-result.json').write_text(json.dumps(report,indent=2))
    print('CAPACITY_REPORT_SAVED',flush=True)
if __name__=='__main__': main()
