"""VM-only synthetic backup -> GCS -> fresh isolated restore verification."""
import hashlib
import json
import subprocess
import urllib.parse
import urllib.request
import uuid

container='kavaroutes-cloud-postgres-1'
target='kr_cloud_restore_'+uuid.uuid4().hex[:12]
created=False

def run(args,data=None):
    return subprocess.run(['docker','exec','-i',container,*args],input=data,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=120).stdout

try:
    dump=run(['pg_dump','-U','kr_cloud_admin','-d','kavaroutes_cloud','-Fc'])
    with urllib.request.urlopen(urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',headers={'Metadata-Flavor':'Google'}),timeout=20) as r:
        token=json.load(r)['access_token']
    bucket='kavaroutes-wp013-backup-76306307395'
    name='synthetic/'+target+'.dump'
    auth={'Authorization':'Bearer '+token}
    url='https://storage.googleapis.com/upload/storage/v1/b/'+bucket+'/o?uploadType=media&ifGenerationMatch=0&name='+urllib.parse.quote(name,safe='')
    with urllib.request.urlopen(urllib.request.Request(url,data=dump,headers={**auth,'Content-Type':'application/octet-stream'},method='POST'),timeout=60) as r:
        obj=json.load(r)
    url='https://storage.googleapis.com/storage/v1/b/'+bucket+'/o/'+urllib.parse.quote(name,safe='')+'?alt=media&generation='+obj['generation']
    with urllib.request.urlopen(urllib.request.Request(url,headers=auth),timeout=60) as r:
        restored_dump=r.read()
    assert hashlib.sha256(dump).digest()==hashlib.sha256(restored_dump).digest()
    run(['createdb','-U','kr_cloud_admin',target]); created=True
    run(['pg_restore','-U','kr_cloud_admin','-d',target,'--exit-on-error'],restored_dump)
    counts="SELECT (SELECT count(*) FROM public.kavaroutes_schema_migration),(SELECT count(*) FROM intake.trip_request),(SELECT count(*) FROM outbox.consumer_projection)"
    before=run(['psql','-U','kr_cloud_admin','-d','kavaroutes_cloud','-Atc',counts])
    after=run(['psql','-U','kr_cloud_admin','-d',target,'-Atc',counts])
    assert before==after
    # Compare deterministic business/schema evidence, not only row counts.
    integrity = """
    SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY id),'')) FROM intake.trip_request t;
    SELECT md5(coalesce(string_agg(row_to_json(t)::text,',' ORDER BY tenant_id,aggregate_id),'')) FROM outbox.consumer_projection t;
    SELECT md5(coalesce(string_agg(migration_name||sha256,',' ORDER BY migration_name),'')) FROM public.kavaroutes_schema_migration;
    SELECT md5(coalesce(string_agg(row_to_json(p)::text,',' ORDER BY schemaname,tablename,policyname),'')) FROM pg_policies p;
    SELECT md5(coalesce(string_agg(n.nspname||'.'||c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity,',' ORDER BY n.nspname,c.relname),''))
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='r' AND n.nspname IN ('intake','outbox','realtime','platform');
    """
    original=run(['psql','-U','kr_cloud_admin','-d','kavaroutes_cloud','-Atc',integrity])
    restored=run(['psql','-U','kr_cloud_admin','-d',target,'-Atc',integrity])
    assert original==restored
    # Exercise restored tenant isolation with a non-superuser application role.
    isolation="""BEGIN;
    SET LOCAL ROLE kavaroutes_api;
    SELECT set_config('app.tenant_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
    SELECT count(*) FROM intake.trip_request;
    ROLLBACK;"""
    denied=run(['psql','-U','kr_cloud_admin','-d',target,'-At','-v','ON_ERROR_STOP=1','-c',isolation]).decode().splitlines()
    assert denied[-2]=='0'
    print(json.dumps({'result':'CLOUD_RESTORE_PASSED','object':name,'generation':obj['generation'],'sha256':hashlib.sha256(dump).hexdigest(),'bytes':len(dump),'migration_trip_projection_counts':after.decode().strip(),
                     'integritySha256':hashlib.sha256(restored).hexdigest(),'restoredOtherTenantRows':0,
                     'checks':['exact-generation-download','dump-checksum','fresh-database-restore','business-digests','migration-digest','policy-definitions','rls-flags','restored-tenant-isolation']}))
except Exception:
    print('CLOUD_RESTORE_FAILED')
    raise SystemExit(1)
finally:
    if created:
        run(['dropdb','-U','kr_cloud_admin',target])
