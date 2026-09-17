"""WSL-only registry upload with short-lived existing gcloud credentials.

Invocation: ``push-runtime.py <tag>`` from the repository root.

A tag is ``<label>-<yyyymmdd>``: a lowercase label of 3-32 characters followed by
an eight-digit date starting 2026. That is the shape every reviewed candidate tag
already uses (``sol004-20260913`` … ``sol009b-20260915``), so the reviewed
vocabulary is enforced structurally instead of being pinned to the already-finished
SOL-009 series. Tag validation happens before any network call; never print token
material or subprocess stderr.
"""
import os
import pathlib
import re
import subprocess
import sys
import tempfile

root=pathlib.Path('/home/chewy/kavaroutes')
TAG=re.compile(r'[a-z][a-z0-9-]{2,31}-2026[0-9]{4}')

def reviewed_tag(value):
    return isinstance(value,str) and bool(TAG.fullmatch(value))

def at_repository_root():
    return pathlib.Path.cwd()==root

def main(argv):
    if len(argv)!=2 or not reviewed_tag(argv[1]) or not at_repository_root():
        raise SystemExit('REVIEWED_RUNTIME_TAG_REQUIRED')
    image='us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime:'+argv[1]
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

if __name__=='__main__':
    main(sys.argv)
