"""Isolated production-profile Compose drill; no host listeners or live data."""
import json
import os
import re
from pathlib import Path
import secrets
import sys
import tempfile
import uuid
from release import BUILD_ID, run


def main(build_id):
    if not BUILD_ID.fullmatch(build_id):
        raise ValueError('SMOKE_BUILD_ID_INVALID')
    root = Path(__file__).resolve().parents[2]
    project = 'kr-vps-smoke-' + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory(prefix='kr-vps-smoke-') as temporary:
        base = Path(temporary)
        for name in ('secrets', 'driver', 'site', 'registrations', 'admin', 'google'):
            (base / name).mkdir(mode=0o700)
        password = {role: secrets.token_urlsafe(32) for role in ('admin', 'api', 'worker')}
        shared = {'profile': 'business-authenticated',
                  'etagSecret': 'synthetic-etag-secret-' + secrets.token_urlsafe(32),
                  'cursorSecret': secrets.token_urlsafe(32)}

        def private(name, value):
            path = base / 'secrets' / name
            path.write_text(value if isinstance(value, str) else json.dumps(value))
            path.chmod(0o600)

        for role, port in (('admin', 58082), ('api', 58082), ('worker', 58081)):
            private(role + '.json', {**shared, 'port': port,
                    'databaseUrl': f'postgresql://kr_cloud_{role}:{password[role]}@127.0.0.1:5432/kavaroutes_cloud'})
        private('postgres-password', password['admin'])
        private('database-passwords.json', {f'kr_cloud_{role}': password[role] for role in ('api', 'worker')})
        private('driver-admins.json', {'accounts': []})
        private('business-identity.json', {'version': 1, 'origin': 'https://app.kavaroutes.com',
                'signingKey': secrets.token_urlsafe(32), 'firebase': None,
                'testAccess': {'issuer': 'https://isolated-test.cloudflareaccess.com',
                               'audience': 'a' * 64,
                               'organizationId': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}})
        private('geoapify.env', '')
        private('site.env', '')
        access = base / 'driver/access.json'
        access.write_text(json.dumps({'version': 1, 'codes': [], 'devices': [],
                                      'events': [], 'driverTokens': []}))
        access.chmod(0o640)
        env = {**os.environ, 'KR_BUILD_ID': build_id,
               'KR_SECRETS_DIRECTORY': str(base / 'secrets'),
               'KR_DRIVER_ACCESS_DIRECTORY': str(base / 'driver'),
               'KR_SITE_DIRECTORY': str(base / 'site'),
               'KR_REGISTRATIONS_DIRECTORY': str(base / 'registrations'),
               'KR_ADMIN_DIRECTORY': str(base / 'admin'),
               'KR_GOOGLE_DIRECTORY': str(base / 'google'),
               'KR_POSTGRES_VOLUME': project + '-db',
               'KR_APP_UID': str(os.getuid()), 'KR_APP_GID': str(os.getgid()),
               'KR_SITE_UID': str(os.getuid()), 'KR_ADMIN_UID': str(os.getuid()),
               'KR_SHARED_GID': str(os.getgid())}
        # Each application still uses the same loopback endpoints, but all are
        # confined to this disposable PostgreSQL container's network namespace.
        override = base / 'override.json'
        override.write_text(json.dumps({'services': {name: {'network_mode':
            'bridge' if name == 'postgres' else 'service:postgres', 'restart': 'no'}
            for name in ('postgres', 'initialize', 'api', 'worker', 'gateway', 'site', 'admin')},
            'volumes': {'database': {'external': False, 'name': project + '-db'}}}))
        compose = ['docker', 'compose', '-p', project, '--env-file', str(root / 'infra/vps/.env.example'),
                   '-f', str(root / 'compose.vps.yml'), '-f', str(override), '--profile', 'admin']

        def execute(args):
            return run(compose + args, env=env)

        phase = 'configuration'
        try:
            execute(['config', '--quiet'])
            phase = 'postgres'
            execute(['up', '-d', '--wait', '--wait-timeout', '120', 'postgres'])
            phase = 'migration'
            execute(['run', '--rm', '--no-deps', 'initialize'])
            phase = 'admin_init'
            execute(['run', '--rm', '--no-deps', 'admin', 'node', 'bin/operator.mjs', 'init',
                     '--directory', '/var/lib/kavaroutes-admin', '--mode', 'cloudflare',
                     '--issuer', 'https://isolated-test.cloudflareaccess.com', '--audience', 'a' * 64])
            phase = 'application_health'
            execute(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180'])
            phase = 'authentication_probes'
            probe = """import assert from 'node:assert/strict';import {request} from 'node:http';
async function get(host,path,port=58080,authorization){return new Promise((resolve,reject)=>{
 const req=request({hostname:'127.0.0.1',port,path,headers:{host,...(authorization?{authorization}:{})},timeout:4000},res=>{
 let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body}));});
 req.on('error',reject);req.on('timeout',()=>req.destroy());req.end();});}
assert.equal((await get('app.kavaroutes.com','/')).status,200);
const gate=await get('driver.kavaroutes.com','/driver');assert.equal(gate.status,303);assert.match(gate.headers.location,/business-access/);
assert.equal((await get('driver.kavaroutes.com','/business-access')).status,200);
assert.equal((await get('driver.kavaroutes.com','/v1/me')).status,404);
assert.equal((await get('driver.kavaroutes.com','/v1/me',58080,'DriverSession dvs_'+ 'x'.repeat(43))).status,401);
assert.equal((await get('app.kavaroutes.com','/v1/me')).status,401);
assert.equal((await get('kavaroutes.com','/',58110)).status,200);
assert.equal((await get('admin.kavaroutes.com','/health/ready',58100)).status,200);
assert.equal((await get('invalid.example','/health/ready',58100)).status,403);
"""
            execute(['exec', '-T', 'gateway', 'node', '--input-type=module', '-e', probe])
            count = execute(['exec', '-T', 'postgres', 'psql', '-U', 'kr_cloud_admin',
                             '-d', 'kavaroutes_cloud', '-Atc', 'SELECT count(*) FROM platform.organization']).strip()
            if count != b'0':
                raise ValueError('SMOKE_UNEXPECTED_BUSINESS_SEED')
            print('VPS_PRODUCTION_PROFILE_SMOKE_PASSED')
        except Exception as error:
            print('VPS_SMOKE_FAILED_AT_' + phase.upper(), file=sys.stderr)
            # This isolated drill uses generated credentials only. Redact all
            # token-shaped strings before reporting infrastructure startup errors.
            context = error.__context__
            if getattr(context, 'stderr', None):
                detail = context.stderr.decode(errors='replace')[:4096]
                print(re.sub(r'[A-Za-z0-9_-]{32,}', '[redacted]', detail), file=sys.stderr)
            if phase == 'migration':
                diagnostic = """import {readConfig,readSecretJson} from './infra/gcp/runtime/config.mjs';
import {initializeDatabase} from './infra/gcp/runtime/database.mjs';
try{await initializeDatabase(await readConfig('/run/secrets/admin.json','admin'),await readSecretJson('/run/secrets/database-passwords.json'));}
catch(error){console.log(JSON.stringify({code:/^[A-Z0-9_]{3,64}$/.test(error.code??'')?error.code:'UNKNOWN',
 reason:/^[A-Z0-9_]{3,64}$/.test(error.message??'')?error.message:'NOT_DISCLOSED'}));}
"""
                try:
                    print(execute(['run','--rm','--no-deps','--entrypoint','node','initialize',
                                   '--input-type=module','-e',diagnostic]).decode().strip(), file=sys.stderr)
                except Exception:
                    pass
            for name in ('postgres', 'api', 'worker', 'gateway', 'site', 'admin'):
                try:
                    identifier = execute(['ps', '-a', '-q', name]).decode().strip()
                    if identifier:
                        info = json.loads(run(['docker', 'inspect', identifier]))[0]['State']
                        print(json.dumps({'service': name, 'status': info['Status'],
                            'exitCode': info['ExitCode'], 'health': info.get('Health', {}).get('Status')}), file=sys.stderr)
                except Exception:
                    pass
            raise
        finally:
            # Only the randomly named disposable test project/volume is removed.
            execute(['down', '--volumes', '--remove-orphans'])


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('SMOKE_BUILD_ID_REQUIRED')
        main(sys.argv[1])
    except Exception as error:
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else 'VPS_SMOKE_FAILED', file=sys.stderr)
        sys.exit(1)
