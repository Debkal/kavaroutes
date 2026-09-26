"""Provision a tenant's Driver business gate. Password is read from stdin only."""
import hashlib
import json
import os
import re
import secrets
import sys

path, business_id, code = sys.argv[1:4]
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', business_id, re.I):
    raise SystemExit('INVALID_BUSINESS_ID')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{2,63}', code):
    raise SystemExit('INVALID_BUSINESS_CODE')
password = sys.stdin.read().rstrip('\r\n')
if not 12 <= len(password) <= 200:
    raise SystemExit('INVALID_PASSWORD_LENGTH')
with open(path, encoding='utf8') as source:
    data = json.load(source)
if not isinstance(data.get('accounts'), list):
    raise SystemExit('INVALID_ACCOUNTS_FILE')
access = data.get('access', [])
if not isinstance(access, list):
    raise SystemExit('INVALID_ACCESS_FILE')
if any(row.get('code') == code and row.get('businessId') != business_id for row in access):
    raise SystemExit('BUSINESS_CODE_ALREADY_ASSIGNED')
salt = secrets.token_hex(16)
password_hash = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, maxmem=32*1024*1024, dklen=64).hex()
data['access'] = [row for row in access if row.get('businessId') != business_id and row.get('code') != code]
data['access'].append(dict(businessId=business_id, code=code, salt=salt, hash=password_hash, enabled=True))
old = os.stat(path)
temporary = path + '.' + secrets.token_hex(8) + '.tmp'
try:
    with open(temporary, 'x', encoding='utf8') as target:
        json.dump(data, target, indent=2)
        target.write('\n')
    os.chown(temporary, old.st_uid, old.st_gid)
    os.chmod(temporary, old.st_mode & 0o777)
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
print('DRIVER_BUSINESS_ACCESS_PROVISIONED', business_id, code)
