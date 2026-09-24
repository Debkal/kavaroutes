import {lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {gmailTransport} from './customer-mail.mjs';

const defaultDirectory='/var/lib/kavaroutes-admin/trip-reports';
const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const validDay=day=>{
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day))fail(400,'INVALID_SERVICE_DATE');
  const parsed=new Date(`${day}T12:00:00Z`);
  if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==day)fail(400,'INVALID_SERVICE_DATE');
  return day;
};
const ready=config=>config.email?.enabled===true&&config.email?.provider==='gmail'&&
  ['from','clientId','clientSecret','refreshToken'].every(key=>!!config.email[key]);

export function initTripReports(store){store.db.exec(`CREATE TABLE IF NOT EXISTS business_workspaces(
  business_id TEXT PRIMARY KEY REFERENCES businesses(id),tenant_id TEXT NOT NULL UNIQUE
    CHECK(tenant_id GLOB '[0-9a-f]*' AND length(tenant_id)=36),
  logging_enabled INTEGER NOT NULL DEFAULT 0 CHECK(logging_enabled IN (0,1)));
  CREATE TABLE IF NOT EXISTS trip_report_email(
  business_id TEXT NOT NULL REFERENCES businesses(id),day TEXT NOT NULL,recipient TEXT NOT NULL,status TEXT NOT NULL,
  created INTEGER NOT NULL,updated INTEGER NOT NULL,provider_id TEXT,last_error TEXT,
  PRIMARY KEY(business_id,day,recipient));`);}

export function setBusinessLogging(store,actor,businessId,enabled){
  if(typeof enabled!=='boolean')fail(400,'INVALID_LOGGING_PREFERENCE');
  workspace(store,businessId);
  store.transaction(()=>{
    store.run('UPDATE business_workspaces SET logging_enabled=? WHERE business_id=?',Number(enabled),businessId);
    store.audit(actor,enabled?'BUSINESS_DEBUG_LOGGING_ENABLED':'BUSINESS_DEBUG_LOGGING_DISABLED',businessId);
  });
  return {enabled};
}

function workspace(store,businessId){
  if(typeof businessId!=='string'||!/^[0-9a-f-]{36}$/.test(businessId))fail(400,'INVALID_BUSINESS');
  const row=store.get(`SELECT b.id,b.name,w.tenant_id FROM businesses b JOIN business_workspaces w
    ON w.business_id=b.id WHERE b.id=?`,businessId);
  if(!row||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.tenant_id))fail(404,'BUSINESS_WORKSPACE_NOT_FOUND');
  return row;
}

async function readReport(day,directory){
  const path=join(directory,`trip-test-${validDay(day)}.txt`);
  let info;
  try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')fail(404,'TRIP_REPORT_NOT_FOUND');throw error;}
  if(!info.isFile()||info.size>512_000||info.size<30||(info.mode&0o077))fail(500,'TRIP_REPORT_INVALID');
  const text=await readFile(path,'utf8');
  const current=text.startsWith(`KavaRoutes live trip test — service date ${day}\n`);
  const legacy=text.startsWith(`KavaRoutes live trip test — ${day} (Pacific time)\n`);
  if(!current&&!legacy)fail(500,'TRIP_REPORT_INVALID');
  const count=Number((current?/^Archived run\/shift events: (\d+)(?:\s|\|)/m:/^Events: (\d+)(?:\s|\|)/m).exec(text)?.[1]);
  if(!Number.isSafeInteger(count))fail(500,'TRIP_REPORT_INVALID');
  return {text,eventCount:count,updatedAt:info.mtime.toISOString()};
}

export async function tripReportView(store,config,recipient,businessId,day,{directory=defaultDirectory}={}){
  const linked=workspace(store,businessId);
  const report=await readReport(day,join(directory,linked.tenant_id));
  const sent=store.get('SELECT status,updated,provider_id,last_error FROM trip_report_email WHERE business_id=? AND day=? AND recipient=?',businessId,day,recipient);
  return {...report,day,businessId,businessName:linked.name,recipient,emailReady:ready(config),emailStatus:sent?.status??null,
    emailUpdatedAt:sent?new Date(sent.updated).toISOString():null};
}

export async function sendTripReport(store,config,recipient,businessId,day,{directory=defaultDirectory,send=gmailTransport}={}){
  const linked=workspace(store,businessId);
  const report=await readReport(day,join(directory,linked.tenant_id));
  if(!report.eventCount)fail(409,'TRIP_REPORT_EMPTY');
  if(!ready(config))fail(503,'ADMIN_GMAIL_NOT_CONFIGURED');
  const now=Date.now(),id=randomUUID();
  store.transaction(()=>{
    const old=store.get('SELECT status FROM trip_report_email WHERE business_id=? AND day=? AND recipient=?',businessId,day,recipient);
    if(old&&old.status!=='FAILED')fail(409,'TRIP_REPORT_EMAIL_ALREADY_ATTEMPTED');
    store.run(`INSERT INTO trip_report_email(business_id,day,recipient,status,created,updated) VALUES(?,?,?,'PROCESSING',?,?)
      ON CONFLICT(business_id,day,recipient) DO UPDATE SET status='PROCESSING',updated=excluded.updated,last_error=NULL`,businessId,day,recipient,now,now);
    store.audit(recipient,'TRIP_REPORT_EMAIL_STARTED',businessId);
  });
  try{
    const providerId=await send({id,created:now,sender:config.email.from,recipient,
      subject:`${linked.name} live trip test ${day} — report`,body:report.text},config.email);
    store.transaction(()=>{
      store.run("UPDATE trip_report_email SET status='ACCEPTED',updated=?,provider_id=?,last_error=NULL WHERE business_id=? AND day=? AND recipient=?",Date.now(),providerId,businessId,day,recipient);
      store.audit(recipient,'TRIP_REPORT_EMAIL_ACCEPTED',businessId);
    });
    return {status:'ACCEPTED',eventCount:report.eventCount};
  }catch(error){
    const uncertain=error.unknown===true;
    store.transaction(()=>{
      store.run('UPDATE trip_report_email SET status=?,updated=?,last_error=? WHERE business_id=? AND day=? AND recipient=?',
        uncertain?'UNKNOWN':'FAILED',Date.now(),uncertain?'CHECK_GMAIL_SENT_BEFORE_RESENDING':'PROVIDER_REJECTED',businessId,day,recipient);
      store.audit(recipient,'TRIP_REPORT_EMAIL_FAILED',businessId);
    });
    fail(502,uncertain?'TRIP_REPORT_SEND_UNCONFIRMED':'TRIP_REPORT_SEND_FAILED');
  }
}
