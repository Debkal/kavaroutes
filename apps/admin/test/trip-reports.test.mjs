import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.mjs';
import {tripReportView,sendTripReport,setBusinessLogging} from '../src/trip-reports.mjs';

const day='2026-09-24',recipient='owner@example.com';
const businessId='11111111-1111-4111-8111-111111111111',tenantId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'kr-trip-report-')),directory=join(root,'reports');mkdirSync(directory);
  const tenantDirectory=join(directory,tenantId);mkdirSync(tenantDirectory);
  const store=openStore(':memory:');
  store.run("INSERT INTO businesses VALUES(?,?,?,'TRIAL','STARTER',1,?,?)",businessId,'test_pony',recipient,Date.now(),Date.now());
  store.run('INSERT INTO business_workspaces(business_id,tenant_id) VALUES(?,?)',businessId,tenantId);
  const text=`KavaRoutes live trip test — ${day} (Pacific time)\nGenerated: Sep 24, 11:00:00 AM PDT\nEvents: 2 | Legs: 1 | Driver actions: 0 | Rejected actions: 0\n\nTRIP LEGS\n  No rider details.\n`;
  writeFileSync(join(tenantDirectory,`trip-test-${day}.txt`),text,{mode:0o600});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {store,directory,text};
}
test('owner trip report preview requires a private, date-matched file',async t=>{
  const {store,directory,text}=fixture(t);
  const config={};
  assert.equal((await tripReportView(store,config,recipient,businessId,day,{directory})).text,text);
  assert.equal((await tripReportView(store,config,recipient,businessId,day,{directory})).emailReady,false);
  await assert.rejects(tripReportView(store,config,recipient,businessId,'../config',{directory}),/INVALID_SERVICE_DATE/);
  await assert.rejects(tripReportView(store,config,recipient,businessId,'2026-09-25',{directory}),/TRIP_REPORT_NOT_FOUND/);
  await assert.rejects(tripReportView(store,config,recipient,businessId,'2027-01-01',{directory}),/TRIP_REPORT_NOT_FOUND/);
  await assert.rejects(tripReportView(store,config,recipient,'22222222-2222-4222-8222-222222222222',day,{directory}),/BUSINESS_WORKSPACE_NOT_FOUND/);
  assert.deepEqual(setBusinessLogging(store,recipient,businessId,true),{enabled:true});
  assert.equal(store.get('SELECT logging_enabled FROM business_workspaces WHERE business_id=?',businessId).logging_enabled,1);
  assert.deepEqual(setBusinessLogging(store,recipient,businessId,false),{enabled:false});
});
test('report email uses admin Gmail, records acceptance, and prevents duplicates',async t=>{
  const {store,directory,text}=fixture(t),calls=[];
  const config={email:{provider:'gmail',enabled:true,from:'reports@example.com',clientId:'private',clientSecret:'private',refreshToken:'private'}};
  const options={directory,send:async(message)=>{calls.push(message);return 'provider-id';}};
  const result=await sendTripReport(store,config,recipient,businessId,day,options);
  assert.equal(result.status,'ACCEPTED');assert.equal(result.eventCount,2);
  assert.equal(calls[0].recipient,recipient);assert.equal(calls[0].body,text);
  assert.equal((await tripReportView(store,config,recipient,businessId,day,{directory})).emailStatus,'ACCEPTED');
  await assert.rejects(sendTripReport(store,config,recipient,businessId,day,options),/TRIP_REPORT_EMAIL_ALREADY_ATTEMPTED/);
  assert.equal(calls.length,1);
});
test('mail stays unsent without credentials; uncertain sends cannot be retried blindly',async t=>{
  const {store,directory}=fixture(t);
  await assert.rejects(sendTripReport(store,{},recipient,businessId,day,{directory,send:()=>assert.fail('sent')}),/ADMIN_GMAIL_NOT_CONFIGURED/);
  const config={email:{provider:'gmail',enabled:true,from:'reports@example.com',clientId:'private',clientSecret:'private',refreshToken:'private'}};
  await assert.rejects(sendTripReport(store,config,recipient,businessId,day,{directory,send:async()=>{throw Object.assign(new Error('network'),{unknown:true});}}),/TRIP_REPORT_SEND_UNCONFIRMED/);
  assert.equal((await tripReportView(store,config,recipient,businessId,day,{directory})).emailStatus,'UNKNOWN');
  await assert.rejects(sendTripReport(store,config,recipient,businessId,day,{directory,send:()=>assert.fail('resent')}),/TRIP_REPORT_EMAIL_ALREADY_ATTEMPTED/);
});
