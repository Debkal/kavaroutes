"""Pull one verified runtime digest with attached VM identity; discard login after."""
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.request

if os.geteuid() != 0 or len(sys.argv) != 2 or not re.fullmatch(r'sha256:[0-9a-f]{64}', sys.argv[1]):
    raise SystemExit('RUNTIME_DIGEST_REQUIRED')
config = pathlib.Path('/opt/kavaroutes/registry-auth')
config.mkdir(mode=0o700, exist_ok=True)
base = ['docker', '--config', str(config)]
try:
    request = urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', headers={'Metadata-Flavor': 'Google'})
    with urllib.request.urlopen(request, timeout=20) as response:
        token = json.load(response)['access_token']
    subprocess.run(base + ['login', '--username', 'oauth2accesstoken', '--password-stdin', 'us-west1-docker.pkg.dev'], input=token, text=True, capture_output=True, check=True, timeout=30)
    subprocess.run(base + ['pull', 'us-west1-docker.pkg.dev/kavaroutes/kavaroutes-wp013/runtime@' + sys.argv[1]], capture_output=True, check=True, timeout=180)
    print('VERIFIED_RUNTIME_DIGEST_PULLED')
except Exception:
    raise SystemExit('RUNTIME_PULL_FAILED')
finally:
    subprocess.run(base + ['logout', 'us-west1-docker.pkg.dev'], capture_output=True, timeout=15)
