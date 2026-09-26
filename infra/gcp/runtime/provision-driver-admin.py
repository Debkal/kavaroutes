"""Provision a business-scoped Driver admin. Password is read from stdin only."""
import hashlib
import json
import os
import re
import secrets
import sys

path, business_id, login_id = sys.argv[1:4]
if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', business_id, re.I):
    raise SystemExit('INVALID_BUSINESS_ID')
if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._@-]{2,127}', login_id):
    raise SystemExit('INVALID_LOGIN_ID')
password = sys.stdin.read().rstrip('\r\n')
if not 12 <= len(password) <= 200:
    raise SystemExit('INVALID_PASSWORD_LENGTH')
with open(path, encoding='utf8') as source:
    data = json.load(source)
if not isinstance(data.get('accounts'), list):
    raise SystemExit('INVALID_ACCOUNTS_FILE')
if any(row['loginId'] == login_id and row['businessId'] != business_id for row in data['accounts']):
    raise SystemExit('LOGIN_ID_OWNED_BY_OTHER_BUSINESS')
salt = secrets.token_hex(16)
password_hash = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, maxmem=32*1024*1024, dklen=64).hex()
data['accounts'] = [row for row in data['accounts'] if row['loginId'] != login_id]
data['accounts'].append(dict(businessId=business_id, loginId=login_id, salt=salt, hash=password_hash, enabled=True))
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
print('DRIVER_ADMIN_PROVISIONED', business_id, login_id)
