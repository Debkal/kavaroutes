"""VM-only protected config delivery using attached workload identity. No secret output."""
import base64
import json
import os
import pathlib
import subprocess
import urllib.request

def get(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=20) as response:
        return json.load(response)

try:
    if os.geteuid() != 0:
        raise ValueError('root required')
    token = get('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {'Metadata-Flavor':'Google'})['access_token']
    secret = get('https://secretmanager.googleapis.com/v1/projects/kavaroutes/secrets/kavaroutes-wp013-runtime/versions/latest:access', {'Authorization':'Bearer '+token})
    files = json.loads(base64.b64decode(secret['payload']['data']))['files']
    if set(files) != {'postgres-password','database-passwords.json','admin.json','api.json','worker.json'}:
        raise ValueError('invalid schema')
    directory = pathlib.Path('/opt/kavaroutes/secrets')
    for name, value in files.items():
        if not isinstance(value,str) or len(value)>8192:
            raise ValueError('invalid value')
        target = directory/name
        if target.exists():
            if target.is_symlink() or target.read_text()!=value:
                raise ValueError('configuration drift')
        else:
            fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
            with os.fdopen(fd,'w') as stream:
                stream.write(value)
        os.chmod(target,0o600)
        os.chown(target,0 if name=='postgres-password' else 1000,0 if name=='postgres-password' else 1000)
    config=pathlib.Path('/opt/kavaroutes/registry-auth')
    config.mkdir(mode=0o700,exist_ok=True)
    subprocess.run(['docker','--config',str(config),'login','--username','oauth2accesstoken','--password-stdin','us-west1-docker.pkg.dev'],input=token,text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=30)
    print('VM_PROTECTED_CONFIGURATION_READY')
except Exception:
    print('VM_CONFIGURATION_FAILED')
    raise SystemExit(1)
