"""Run on the private VM: synthetic REST, idempotency, worker and tenant checks."""
import json
import subprocess
import time
import urllib.error
import urllib.request
import uuid

tenant='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
trip=str(uuid.uuid4())
key=str(uuid.uuid4())
payload={'tripId':trip,'riderId':'11111111-1111-4111-8111-111111111112','serviceDate':'2026-09-12','serviceTimezone':'America/Los_Angeles','localServiceTime':'08:00:00','resolvedServiceAt':'2026-09-12T15:00:00.000Z','resolvedUtcOffsetSeconds':-25200,'ambiguityPolicy':'reject'}

def request(path, method='GET', data=None, auth=True):
    headers={'Content-Type':'application/json','Idempotency-Key':key}
    if auth:
        headers['Authorization']='Synthetic principal_dispatcher'
    req=urllib.request.Request('http://127.0.0.1:58080'+path,method=method,headers=headers,data=json.dumps(data).encode() if data else None)
    try:
        with urllib.request.urlopen(req,timeout=10) as response:
            return response.status,response.read()
    except urllib.error.HTTPError as error:
        return error.code,error.read()

def scalar(sql):
    return subprocess.check_output(['docker','exec','kavaroutes-cloud-postgres-1','psql','-U','kr_cloud_admin','-d','kavaroutes_cloud','-Atc',sql],text=True,timeout=15).strip()

try:
    path=f'/v1/organizations/{tenant}/trips'
    assert request(path,auth=False)[0]==401
    first=request(path,'POST',payload)
    assert first[0]==201
    second=request(path,'POST',payload)
    assert second==first
    assert request(f'/v1/organizations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/trips')[0] in (403,404)
    query=f"SELECT count(*) FROM outbox.consumer_projection WHERE tenant_id='{tenant}' AND aggregate_id='{trip}'"
    for _ in range(60):
        if int(scalar(query))>0:
            break
        time.sleep(1)
    else:
        raise ValueError('projection timeout')
    assert scalar(f"SELECT count(*) FROM intake.trip_request WHERE tenant_id='{tenant}' AND id='{trip}'")=='1'
    print(json.dumps({'result':'CLOUD_SMOKE_PASSED','checks':['unauthenticated-denied','trip-created','idempotency-replay','other-tenant-denied','worker-projection'],'syntheticTripId':trip}))
except Exception:
    print('CLOUD_SMOKE_FAILED')
    raise SystemExit(1)
