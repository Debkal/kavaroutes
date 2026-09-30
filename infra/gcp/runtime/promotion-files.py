"""Reviewed optional file changes, backed up with an image promotion.

Secret contents never enter output. Sources must be regular protected files in
one root-owned release directory. Targets are a closed list, not manifest-owned
arbitrary paths. A failed promotion restores every file before restarting the
previous image, including its original configuration and mounted adapters.
"""
import json
import os
import pathlib
import shutil

TARGETS = frozenset([
 '/opt/kavaroutes/secrets/api.json', '/opt/kavaroutes/secrets/worker.json',
 '/opt/kavaroutes/secrets/admin.json', '/opt/kavaroutes/secrets/business-identity.json',
 '/opt/kavaroutes/runtime/prototype-compose.override.yaml',
 '/opt/kavaroutes/web/prototype-web-gateway.mjs',
 '/opt/kavaroutes/web/driver-sessions.mjs', '/opt/kavaroutes/web/driver-access-management.mjs',
])

class PromotionFiles:
 def __init__(self, root, backup_dir, label):
  self.manifest = root / ('candidate-files.' + label + '.json')
  self.backup = backup_dir / (label + '-files')
  self.files = []
  self.applied = False
  if not self.manifest.exists(): return
  if self.manifest.is_symlink() or self.manifest.stat().st_mode & 0o077: raise ValueError('release manifest requires review')
  value=json.loads(self.manifest.read_text())
  if set(value) != {'version','files'} or value['version'] != 1 or not isinstance(value['files'],list) or len(value['files']) > len(TARGETS): raise ValueError('release manifest invalid')
  directory=root / ('release-' + label)
  if directory.is_symlink() or not directory.is_dir() or self.backup.exists(): raise ValueError('release directory invalid')
  seen=set()
  for entry in value['files']:
   if set(entry) != {'source','target'}: raise ValueError('release entry invalid')
   target=pathlib.Path(entry['target']);source=directory / entry['source']
   if str(target) not in TARGETS or target in seen or pathlib.Path(entry['source']).name != entry['source']: raise ValueError('release target invalid')
   if source.is_symlink() or not source.is_file() or source.stat().st_mode & 0o077 or source.stat().st_size > 131072: raise ValueError('release source invalid')
   if target.is_symlink() or (target.exists() and not target.is_file()): raise ValueError('release target invalid')
   seen.add(target);self.files.append({'source':source,'target':target,'stat':target.stat() if target.exists() else None})
 def preserve(self):
  if not self.files:return
  self.backup.mkdir(mode=0o700)
  for index,entry in enumerate(self.files):
   if entry['stat'] is not None:
    shutil.copyfile(entry['target'],self.backup / str(index));os.chmod(self.backup / str(index),0o600)
 def apply(self):
  self.applied=True
  for entry in self.files:
   shutil.copyfile(entry['source'],entry['target'])
   stat=entry['stat']
   os.chmod(entry['target'],stat.st_mode & 0o777 if stat else 0o600)
   os.chown(entry['target'],stat.st_uid if stat else 1000,stat.st_gid if stat else 1000)
 def restore(self):
  if not self.applied:return
  for index,entry in enumerate(self.files):
   if entry['stat'] is None:entry['target'].unlink(missing_ok=True)
   else:
    shutil.copyfile(self.backup / str(index),entry['target']);os.chmod(entry['target'],entry['stat'].st_mode & 0o777)
    os.chown(entry['target'],entry['stat'].st_uid,entry['stat'].st_gid)
