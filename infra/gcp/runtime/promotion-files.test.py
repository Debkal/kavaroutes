import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('files',pathlib.Path(__file__).with_name('promotion-files.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class PromotionFilesTest(unittest.TestCase):
 def test_closed_manifest_and_complete_restore(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);backups=root/'backups';backups.mkdir();release=root/'release-identity';release.mkdir()
   old=root/'api.json';new=root/'business.json';old.write_text('original configuration');old.chmod(0o600)
   for name in ['api','business']:(release/name).write_text('new configuration');(release/name).chmod(0o600)
   manifest=root/'candidate-files.identity.json';manifest.write_text(json.dumps({'version':1,'files':[{'source':'api','target':str(old)},{'source':'business','target':str(new)}]}));manifest.chmod(0o600)
   with patch.object(module,'TARGETS',frozenset([str(old),str(new)])),patch.object(module.os,'chown'):
    files=module.PromotionFiles(root,backups,'identity');files.preserve();files.apply()
    self.assertEqual(old.read_text(),'new configuration');self.assertTrue(new.exists())
    files.restore();self.assertEqual(old.read_text(),'original configuration');self.assertFalse(new.exists())
   bad=json.loads(manifest.read_text());bad['files'][0]['source']='../outside';manifest.write_text(json.dumps(bad))
   with self.assertRaises(ValueError):module.PromotionFiles(root,backups,'identity')
 def test_absent_manifest_does_not_change_ordinary_deployments(self):
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);files=module.PromotionFiles(root,root/'backups','ordinary');files.preserve();files.apply();files.restore()
   self.assertEqual(list(root.iterdir()),[])
if __name__=='__main__':unittest.main()
