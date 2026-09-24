import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore as openSiteStore} from '../../site/server/store.mjs';
import {openStore as openAdminStore} from '../src/store.mjs';
import {syncSiteBusinesses} from '../src/business-sync.mjs';

test('verified signup ID is mirrored into the admin business directory',async t=>{
  const root=mkdtempSync(join(tmpdir(),'kr-business-sync-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const registrations=join(root,'registrations');
  const site=openSiteStore(join(root,'site.sqlite'),{registrationDirectory:registrations});
  const admin=openAdminStore(join(root,'admin.sqlite'));
  t.after(()=>{site.close();admin.close();});
  site.enroll('firebase-owner-1','Calm Transit','owner@example.com');
  const id=site.get('firebase-owner-1').businessId;
  assert.equal(await syncSiteBusinesses(admin,registrations),1);
  const business=admin.get('SELECT * FROM businesses WHERE id=?',id);
  assert.equal(business.name,'Calm Transit');assert.equal(business.contact,'owner@example.com');
  assert.equal(admin.get('SELECT subject FROM business_account_links WHERE business_id=?',id).subject,'firebase-owner-1');
  assert.equal(await syncSiteBusinesses(admin,registrations),0);
  site.refreshRegistration('firebase-owner-1','new-owner@example.com');
  assert.equal(await syncSiteBusinesses(admin,registrations),0);
  assert.equal(admin.get('SELECT contact FROM businesses WHERE id=?',id).contact,'owner@example.com');
  assert.equal(admin.get('SELECT owner_email FROM business_account_links WHERE business_id=?',id).owner_email,'new-owner@example.com');
});
