"""Read-only deployment evidence; never print tunnel tokens or identity payloads."""
import json
import pathlib
import re
import subprocess
import urllib.request
import urllib.error

base = 'http://127.0.0.1:58100'
headers = {'Host': 'admin.kavaroutes.com', 'Origin': 'https://admin.kavaroutes.com',
           'Content-Type': 'application/json'}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for path, data, expected in [
    ('/health/ready', None, 200),
    ('/api/challenge', b'{"email":"kavasupport@kavaroutes.com"}', 401),
    ('/api/dashboard', b'{}', 401),
]:
    request = urllib.request.Request(base + path, data=data, headers=headers)
    try:
        with opener.open(request, timeout=5) as response:
            status = response.status
    except urllib.error.HTTPError as error:
        status = error.code
    if status != expected:
        raise SystemExit('ADMIN_HTTP_CHECK_FAILED')
print('ADMIN_HEALTH_AND_UNAUTHENTICATED_DENIAL_VERIFIED')

pid = subprocess.check_output(['systemctl', 'show', 'cloudflared', '--property=MainPID', '--value'], text=True).strip()
args = pathlib.Path('/proc/' + pid + '/cmdline').read_bytes().split(b'\0')
print('TUNNEL_STRICT_POST_QUANTUM_FLAG=' + str(b'--post-quantum' in args).lower())
logs = subprocess.check_output(['journalctl', '-u', 'cloudflared', '-n', '150', '--no-pager', '-o', 'cat'], text=True)
for line in reversed(logs.splitlines()):
    if 'Updated to new configuration' not in line or 'config=' not in line:
        continue
    try:
        encoded, _ = json.JSONDecoder().raw_decode(line.split('config=', 1)[1])
        config = json.loads(encoded) if isinstance(encoded, str) else encoded
        routes = [entry for entry in config.get('ingress', []) if entry.get('hostname') == 'admin.kavaroutes.com']
        for entry in routes:
            origin = entry.get('originRequest', {})
            print(json.dumps({'adminRoute': entry.get('service'),
                              'httpHostHeader': origin.get('httpHostHeader'),
                              'connectorAccessValidation': origin.get('access', {}).get('required', False)}))
        if not routes:
            print('ADMIN_ROUTE_NOT_IN_LATEST_RECORDED_CONFIG')
    except (ValueError, TypeError, AttributeError):
        print('TUNNEL_CONFIG_LOG_NOT_PARSEABLE')
    break
else:
    print('TUNNEL_CONFIG_NOT_IN_RECENT_LOGS')

# Print only negotiated algorithm names, never whole connector log lines.
algorithms = sorted(set(re.findall(r'(?:X25519MLKEM768|X25519Kyber768Draft00)', logs)))
print('RECENT_TUNNEL_PQ_ALGORITHMS=' + ','.join(algorithms))
