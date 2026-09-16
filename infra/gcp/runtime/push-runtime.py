"""WSL-only registry upload with short-lived existing gcloud credentials."""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

root=pathlib.Path('/home/chewy/kavaroutes')
if pathlib.Path.cwd()!=root or len(sys.argv)!=2 or not re.fullmatch(r'(?:sol00[4-9]|sol009b)-202609[0-9]{2}',sys.argv[1]):
    raise SystemExit('REVIEWED_RUNTIME_TAG_REQUIRED')
image='us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:'+sys.argv[1]
environment={**os.environ,'CLOUDSDK_CONFIG':str(root/'.tooling/gcloud-config'),'CLOUDSDK_CORE_DISABLE_PROMPTS':'1'}
with tempfile.TemporaryDirectory(prefix='registry-push-',dir=root/'.tooling/gcp') as directory:
    base=['docker','--config',directory]
    try:
        token=subprocess.run([str(root/'.tooling/google-cloud-sdk/bin/gcloud'),'auth','print-access-token','--project=kavaroutes'],env=environment,capture_output=True,check=True,timeout=60).stdout
        subprocess.run(base+['login','--username','oauth2accesstoken','--password-stdin','us-west1-docker.pkg.dev'],input=token,capture_output=True,check=True,timeout=30)
        subprocess.run(base+['push',image],capture_output=True,check=True,timeout=300)
        print('RUNTIME_CANDIDATE_PUSHED')
    except Exception:
        raise SystemExit('RUNTIME_PUSH_FAILED')
    finally:
        subprocess.run(base+['logout','us-west1-docker.pkg.dev'],capture_output=True,timeout=30)
