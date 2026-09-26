"""Create the shared Driver access registry from the original private password hashes."""
import json
import os
import secrets
import sys
import uuid

source, directory = sys.argv[1:3]
os.makedirs(directory, mode=0o700, exist_ok=True)
path = os.path.join(directory, 'access.json')
if os.path.exists(path):
    print('DRIVER_ACCESS_REGISTRY_EXISTS')
    raise SystemExit(0)
with open(source, encoding='utf8') as file:
    old = json.load(file)
codes=[]
for row in old.get('access', []):
    codes.append(dict(id=str(uuid.uuid4()), businessId=row['businessId'], code=row['code'], kind='SHARED', label='Business shared access', enabled=row['enabled'], uses=0, createdAt=0, updatedAt=0, salt=row['salt'], hash=row['hash']))
with open(path, 'x', encoding='utf8') as file:
    json.dump(dict(version=1,codes=codes,devices=[],events=[],driverTokens=[]),file,indent=2)
    file.write('\n')
os.chmod(path,0o640)
print('DRIVER_ACCESS_REGISTRY_CREATED',len(codes))
