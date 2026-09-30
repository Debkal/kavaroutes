"""Prepare protected migration configuration on the existing VM, without
printing credentials or changing live files. Promotion owns backup/activation.
"""
import json
import os
import pathlib
import re
import shutil
import sqlite3
import sys
import secrets

ROOT=pathlib.Path('/opt/kavaroutes/runtime')
SECRETS=pathlib.Path('/opt/kavaroutes/secrets')

def main():
 if os.geteuid()!=0 or len(sys.argv)!=5:raise ValueError('invalid invocation')
 label,business_id,app_audience,stage=sys.argv[1:]
 if not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,31}',label) or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}',business_id) or not re.fullmatch(r'[a-f0-9]{64}',app_audience):raise ValueError('invalid migration identity')
 stage=pathlib.Path(stage);release=ROOT/('release-'+label);manifest=ROOT/('candidate-files.'+label+'.json')
 if release.exists() or manifest.exists():raise ValueError('candidate already exists')
 config=json.loads(pathlib.Path('/var/lib/kavaroutes-admin/config.json').read_text())
 database=sqlite3.connect('file:'+config['database']+'?mode=ro',uri=True)
 owners=database.execute("SELECT subject FROM admins WHERE role='OWNER' AND state='ACTIVE'").fetchall()
 linked=database.execute('SELECT tenant_id FROM business_workspaces WHERE business_id=?',[business_id]).fetchone()
 database.close()
 if len(owners)!=1 or not owners[0][0] or linked!=(business_id,):raise ValueError('explicit test owner and workspace required')
 release.mkdir(mode=0o700)
 files=[]
 def candidate(name,target,value=None,source=None):
  path=release/name
  if source is not None:shutil.copyfile(source,path)
  else:path.write_text(json.dumps(value,indent=2)+'\n')
  path.chmod(0o600);files.append({'source':name,'target':str(target)})
 for name in ['api','worker','admin']:
  value=json.loads((SECRETS/(name+'.json')).read_text());value['profile']='business-authenticated'
  candidate(name+'.json',SECRETS/(name+'.json'),value)
 identity_path=SECRETS/'business-identity.json'
 if identity_path.exists():raise ValueError('existing identity configuration requires review')
 candidate('business-identity.json',identity_path,{'version':1,'origin':'https://app.kavaroutes.com','signingKey':secrets.token_urlsafe(32),
  'testAccess':{'issuer':config['accessIssuer'],'audience':app_audience,'organizationId':business_id},
  'adminAccess':{'issuer':config['accessIssuer'],'audience':config['accessAudience']},'firebase':None})
 for name,target in [('prototype-compose.override.yaml',ROOT/'prototype-compose.override.yaml'),
  ('prototype-web-gateway.mjs',pathlib.Path('/opt/kavaroutes/web/prototype-web-gateway.mjs')),
  ('driver-sessions.mjs',pathlib.Path('/opt/kavaroutes/web/driver-sessions.mjs')),
  ('driver-access-management.mjs',pathlib.Path('/opt/kavaroutes/web/driver-access-management.mjs'))]:candidate(name,target,source=stage/name)
 # Subject is already bound to the verified platform owner; no implicit email match.
 admission=release/'test-owner.json';admission.write_text(json.dumps({'organizationId':business_id,'issuer':config['accessIssuer'],'subject':owners[0][0]}));admission.chmod(0o600)
 manifest.write_text(json.dumps({'version':1,'files':files}));manifest.chmod(0o600)
 print('BUSINESS_IDENTITY_CANDIDATE_PREPARED')
if __name__=='__main__':
 try:main()
 except Exception:
  print('BUSINESS_IDENTITY_PREPARATION_REQUIRES_REVIEW');raise SystemExit(1)
