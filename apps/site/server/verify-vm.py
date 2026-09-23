"""Only emit public route details and HTTP checks; never tunnel credentials."""
import json
import subprocess
import urllib.request
import urllib.error

opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
for path, expected in [('/',200),('/sign-in',200),('/api/config',200),('/api/account',401),('/v1/me',404)]:
    try:
        with opener.open('http://127.0.0.1:58110'+path,timeout=5) as response:
            status=response.status
            if path=='/api/config':
                assert json.load(response)=={'authEnabled':False,'firebase':None,'checkoutEnabled':False}
    except urllib.error.HTTPError as error:
        status=error.code
    assert status==expected,(path,status)
    print('SITE_HTTP',path,status)
logs=subprocess.check_output(['journalctl','-u','cloudflared','-n','500','--no-pager','-o','cat'],text=True)
for line in reversed(logs.splitlines()):
    if 'Updated to new configuration' not in line or 'config=' not in line:
        continue
    try:
        encoded,_=json.JSONDecoder().raw_decode(line.split('config=',1)[1])
        config=json.loads(encoded) if isinstance(encoded,str) else encoded
        for entry in config.get('ingress',[]):
            print(json.dumps({'hostname':entry.get('hostname'),'service':entry.get('service')}))
    except (ValueError,TypeError,AttributeError):
        print('TUNNEL_ROUTE_SUMMARY_UNAVAILABLE')
    break
else:
    print('TUNNEL_CONFIGURATION_NOT_IN_RECENT_LOGS')
