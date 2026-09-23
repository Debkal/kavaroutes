import {randomUUID} from 'node:crypto';
import {adminStatus} from './logging.mjs';
const day=86400000;
const fail=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const clean=(v,max=200,optional=false,multiline=false)=>{if(typeof v!=='string'||(!optional&&!v.trim())||v.length>max||(multiline?/[\x00-\x08\x0b\x0c\x0e-\x1f]/:/[\x00-\x1f]/).test(v))fail('INVALID_EMAIL_FIELD');return v.trim();};
const variables=['business_name','contact_name','invoice_number','due_date','amount_due','service_period','amount_paid','payment_date','payment_reference'];
export function initCustomerMail(s){s.db.exec(`
 CREATE TABLE IF NOT EXISTS customer_profiles(business_id TEXT PRIMARY KEY REFERENCES businesses(id),contact_name TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',email_enabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS email_templates(id TEXT PRIMARY KEY,name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
 CREATE TABLE IF NOT EXISTS email_rules(id TEXT PRIMARY KEY,name TEXT NOT NULL,template_id TEXT NOT NULL REFERENCES email_templates(id),offset_days INTEGER NOT NULL,hour_utc INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'INVOICE_DUE');
 CREATE TABLE IF NOT EXISTS email_outbox(id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),invoice_id TEXT REFERENCES invoices(id),rule_id TEXT REFERENCES email_rules(id),recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL,scheduled_at INTEGER NOT NULL,created INTEGER NOT NULL,actor TEXT NOT NULL,dedupe TEXT UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,first_attempt INTEGER,locked_at INTEGER,provider_id TEXT,last_error TEXT,sender TEXT,purpose TEXT NOT NULL DEFAULT 'GENERAL');
 CREATE INDEX IF NOT EXISTS email_due ON email_outbox(status,scheduled_at);
 `);
 if(!s.all('PRAGMA table_info(email_rules)').some(c=>c.name==='kind'))s.db.exec("ALTER TABLE email_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'INVOICE_DUE'");
 if(!s.all('PRAGMA table_info(email_outbox)').some(c=>c.name==='purpose'))s.db.exec("ALTER TABLE email_outbox ADD COLUMN purpose TEXT NOT NULL DEFAULT 'GENERAL'");
 s.run('INSERT OR IGNORE INTO email_templates(id,name,subject,body) VALUES(?,?,?,?)','10000000-0000-4000-8000-000000000001','Payment receipt','Payment received — {{invoice_number}}','Hello {{contact_name}},\n\nWe have recorded your payment for {{business_name}}.\n\nInvoice: {{invoice_number}}\nStatus: PAID\nAmount paid: {{amount_paid}}\nPayment date: {{payment_date}}\nPayment reference: {{payment_reference}}\nService period: {{service_period}}\n\nPlease keep this email as your payment receipt.\nThank you,\nKavaRoutes');
 s.run("INSERT OR IGNORE INTO email_rules(id,name,template_id,offset_days,hour_utc,enabled,kind) VALUES(?,?,?,0,0,1,'PAYMENT_RECEIVED')",'10000000-0000-4000-8000-000000000002','Payment confirmation','10000000-0000-4000-8000-000000000001');
}
function customer(s,id){const b=s.get('SELECT b.*,coalesce(p.contact_name,\'\') AS contact_name,coalesce(p.email_enabled,0) AS email_enabled FROM businesses b LEFT JOIN customer_profiles p ON p.business_id=b.id WHERE b.id=?',clean(id,36));if(!b)fail('CUSTOMER_NOT_FOUND',404);return b;}
function template(s,id){const t=s.get('SELECT * FROM email_templates WHERE id=?',clean(id,36));if(!t)fail('TEMPLATE_NOT_FOUND',404);return t;}
function validTemplate(subject,body){clean(subject,200);clean(body,10000,false,true);const all=subject+'\n'+body;const rest=all.replace(/{{\s*([a-z_]+)\s*}}/g,(_,key)=>{if(!variables.includes(key))fail('UNKNOWN_TEMPLATE_VARIABLE');return '';});if(rest.includes('{{')||rest.includes('}}'))fail('INVALID_TEMPLATE_VARIABLE');}
export function saveCustomer(s,actor,d){customer(s,d.businessId);const name=clean(d.contactName,120,true),phone=clean(d.phone,60,true),notes=clean(d.notes,2000,true,true);if(typeof d.emailEnabled!=='boolean')fail('INVALID_EMAIL_PREFERENCE');return s.transaction(()=>{const old=s.get('SELECT version FROM customer_profiles WHERE business_id=?',d.businessId);if(old&&old.version!==d.version)fail('CUSTOMER_CHANGED_RELOAD',409);s.run(`INSERT INTO customer_profiles VALUES(?,?,?,?,?,1) ON CONFLICT(business_id) DO UPDATE SET contact_name=excluded.contact_name,phone=excluded.phone,notes=excluded.notes,email_enabled=excluded.email_enabled,version=version+1`,d.businessId,name,phone,notes,Number(d.emailEnabled));s.audit(actor,'CUSTOMER_CONTACT_UPDATED',d.businessId);return {ok:true};});}
export function saveTemplate(s,actor,d){const name=clean(d.name,120),subject=clean(d.subject,200),body=clean(d.body,10000,false,true);validTemplate(subject,body);return s.transaction(()=>{const id=d.id?clean(d.id,36):randomUUID();if(d.id){if(!s.run('UPDATE email_templates SET name=?,subject=?,body=?,version=version+1 WHERE id=? AND version=?',name,subject,body,id,d.version??0).changes)fail('TEMPLATE_CHANGED_RELOAD',409);}else s.run('INSERT INTO email_templates VALUES(?,?,?,?,1)',id,name,subject,body);s.audit(actor,'EMAIL_TEMPLATE_SAVED',id);return {id};});}
export function renderEmail(s,d){const b=customer(s,d.businessId),t=template(s,d.templateId);let invoice=null;if(d.invoiceId){invoice=s.get('SELECT * FROM invoices WHERE id=? AND business_id=?',clean(d.invoiceId,36),b.id);if(!invoice||!['ISSUED','PAID'].includes(invoice.status))fail('ISSUED_OR_PAID_CUSTOMER_INVOICE_REQUIRED');}
 const values={business_name:b.name,contact_name:b.contact_name||b.name};
 if(invoice)Object.assign(values,{invoice_number:`KR-${String(invoice.number).padStart(6,'0')}`,due_date:invoice.due_date,amount_due:new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(invoice.total_cents/100),service_period:`${invoice.period_start} to ${invoice.period_end}`});
 if(invoice?.status==='PAID')Object.assign(values,{amount_paid:values.amount_due,payment_date:invoice.payment_date,payment_reference:invoice.payment_reference});
 const render=v=>v.replace(/{{\s*([a-z_]+)\s*}}/g,(_,key)=>{if(!(key in values))fail('SELECT_INVOICE_FOR_THIS_TEMPLATE');return values[key];});
 const subject=render(t.subject),body=render(t.body);clean(subject,500);clean(body,15000,false,true);
 return {businessId:b.id,invoiceId:invoice?.id??null,recipient:b.contact,subject,body,purpose:invoice?.status==='PAID'?'RECEIPT':invoice?'REMINDER':'GENERAL'};
}
function insertMessage(s,actor,d,status,when,dedupe=null,rule=null,now=Date.now()){
 const preview=renderEmail(s,d),id=randomUUID();s.run('INSERT INTO email_outbox(id,business_id,invoice_id,rule_id,recipient,subject,body,status,scheduled_at,created,actor,dedupe,purpose) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',id,preview.businessId,preview.invoiceId,rule,preview.recipient,preview.subject,preview.body,status,when,now,actor,dedupe,preview.purpose);return {id,...preview};
}
export function previewEmail(s,actor,d){return s.transaction(()=>{s.run("DELETE FROM email_outbox WHERE status='DRAFT' AND created<?",Date.now()-day);return insertMessage(s,actor,d,'DRAFT',Date.now());});}
export function queueEmail(s,actor,d){return s.transaction(()=>{const m=s.get("SELECT * FROM email_outbox WHERE id=? AND actor=? AND status='DRAFT'",clean(d.id,36),actor);if(!m||m.created<Date.now()-day)fail('PREVIEW_AGAIN',409);const b=customer(s,m.business_id);if(!b.email_enabled||b.status==='SUSPENDED')fail('CUSTOMER_EMAIL_DISABLED');if(b.contact!==m.recipient)fail('CONTACT_CHANGED_PREVIEW_AGAIN',409);const when=d.scheduledAt===null?Date.now():Date.parse(d.scheduledAt);if(!Number.isFinite(when)||when<Date.now()-60000||when>Date.now()+366*day)fail('INVALID_SEND_TIME');s.run("UPDATE email_outbox SET status='QUEUED',scheduled_at=? WHERE id=?",when,m.id);s.audit(actor,'EMAIL_SCHEDULED',m.id);return {id:m.id};});}
export function cancelEmail(s,actor,d){return s.transaction(()=>{if(!s.run("UPDATE email_outbox SET status='CANCELED' WHERE id=? AND status IN ('DRAFT','QUEUED')",clean(d.id,36)).changes)fail('EMAIL_ALREADY_PROCESSING_OR_FINISHED',409);s.audit(actor,'EMAIL_CANCELED',d.id);return {ok:true};});}
export function saveRule(s,actor,d){const t=template(s,d.templateId);const kind=d.kind??'INVOICE_DUE';if(!['INVOICE_DUE','PAYMENT_RECEIVED'].includes(kind))fail('INVALID_RULE_KIND');if(kind==='INVOICE_DUE'&&/\{\{\s*(amount_paid|payment_date|payment_reference)\s*\}\}/.test(t.subject+t.body))fail('PAYMENT_TEMPLATE_REQUIRES_PAYMENT_RULE');const name=clean(d.name,120);if(!Number.isInteger(d.offsetDays)||Math.abs(d.offsetDays)>30||!Number.isInteger(d.hourUtc)||d.hourUtc<0||d.hourUtc>23||typeof d.enabled!=='boolean')fail('INVALID_REMINDER_RULE');return s.transaction(()=>{const id=d.id?clean(d.id,36):randomUUID();if(d.id){if(!s.run('UPDATE email_rules SET name=?,template_id=?,offset_days=?,hour_utc=?,enabled=?,kind=?,version=version+1 WHERE id=? AND version=?',name,d.templateId,d.offsetDays,d.hourUtc,Number(d.enabled),kind,id,d.version??0).changes)fail('RULE_CHANGED_RELOAD',409);if(!d.enabled)s.run("UPDATE email_outbox SET status='CANCELED',last_error='RULE_DISABLED' WHERE rule_id=? AND status='QUEUED'",id);}else s.run('INSERT INTO email_rules(id,name,template_id,offset_days,hour_utc,enabled,kind) VALUES(?,?,?,?,?,?,?)',id,name,d.templateId,d.offsetDays,d.hourUtc,Number(d.enabled),kind);s.audit(actor,'EMAIL_RULE_SAVED',id);return {id};});}
export function mailView(s,config){return {deliveryConfigured:!!(config.email?.provider==='gmail'&&config.email?.refreshToken&&config.email?.clientId&&config.email?.clientSecret&&config.email?.from),deliveryEnabled:config.email?.enabled===true,from:config.email?.from??null,variables,customers:s.all('SELECT b.id,b.name,b.contact,b.plan,b.status,p.contact_name,p.phone,p.notes,coalesce(p.email_enabled,0) AS email_enabled,p.version FROM businesses b LEFT JOIN customer_profiles p ON p.business_id=b.id ORDER BY b.name LIMIT 500'),templates:s.all('SELECT * FROM email_templates ORDER BY name'),rules:s.all('SELECT * FROM email_rules ORDER BY name'),invoices:s.all("SELECT id,business_id,number,due_date,status FROM invoices WHERE status IN ('ISSUED','PAID') ORDER BY due_date LIMIT 1000"),messages:s.all("SELECT id,business_id,recipient,subject,status,scheduled_at,provider_id,last_error FROM email_outbox WHERE status!='DRAFT' ORDER BY created DESC LIMIT 200")};}
function enqueueRule(s,rule,i,now,dedupe){
 try{insertMessage(s,'scheduler',{businessId:i.business_id,invoiceId:i.id,templateId:rule.template_id},'QUEUED',now,dedupe,rule.id,now);s.audit('scheduler',rule.kind==='PAYMENT_RECEIVED'?'PAYMENT_RECEIPT_QUEUED':'INVOICE_REMINDER_QUEUED',i.id);}
 catch(error){if(!error.code)throw error;const b=customer(s,i.business_id);s.run("INSERT INTO email_outbox(id,business_id,invoice_id,rule_id,recipient,subject,body,status,scheduled_at,created,actor,dedupe,last_error) VALUES(?,?,?,?,?,?,?,'FAILED',?,?,'scheduler',?,?)",randomUUID(),b.id,i.id,rule.id,b.contact,'Email template could not be rendered','',now,now,dedupe,'TEMPLATE_RENDER_FAILED');s.audit('scheduler','EMAIL_TEMPLATE_FAILED',i.id);}
}
// Called inside the same transaction that records a paid invoice; no network call here.
export function enqueuePaymentReceipts(s,invoiceId,now=Date.now()){
 const i=s.get("SELECT id,business_id FROM invoices WHERE id=? AND status='PAID'",invoiceId);if(!i)return;
 const b=customer(s,i.business_id);if(!b.email_enabled||b.status==='SUSPENDED')return;
 for(const rule of s.all("SELECT * FROM email_rules WHERE enabled=1 AND kind='PAYMENT_RECEIVED'")){
  const dedupe=`rule:${rule.id}:invoice:${i.id}`;if(!s.get('SELECT id FROM email_outbox WHERE dedupe=?',dedupe))enqueueRule(s,rule,i,now,dedupe);
 }
}
export function generateReminders(s,now=Date.now()){
 const today=new Date(now).toISOString().slice(0,10),hour=new Date(now).getUTCHours();
 for(const rule of s.all("SELECT * FROM email_rules WHERE enabled=1 AND kind='INVOICE_DUE' AND hour_utc<=?",hour)){
  const due=new Date(Date.parse(today)-rule.offset_days*day).toISOString().slice(0,10);
  for(const i of s.all("SELECT i.id,i.business_id FROM invoices i JOIN businesses b ON b.id=i.business_id JOIN customer_profiles p ON p.business_id=b.id WHERE i.status='ISSUED' AND i.due_date=? AND p.email_enabled=1 AND b.status!='SUSPENDED' LIMIT 1000",due)){
   const dedupe=`rule:${rule.id}:invoice:${i.id}`;if(s.get('SELECT id FROM email_outbox WHERE dedupe=?',dedupe))continue;
   s.transaction(()=>enqueueRule(s,rule,i,now,dedupe));
  }
 }
}
export function gmailMime(message){
 for(const address of [message.sender,message.recipient])if(typeof address!=='string'||! /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(address))fail('INVALID_MAIL_ADDRESS');
 // Fold UTF-8 encoded words and base64 body to keep MIME lines bounded.
 const chunks=[];let chunk='';for(const c of message.subject){if(Buffer.byteLength(chunk+c)>42){chunks.push(chunk);chunk='';}chunk+=c;}if(chunk)chunks.push(chunk);
 const subject=chunks.map(c=>'=?UTF-8?B?'+Buffer.from(c).toString('base64')+'?=').join('\r\n ');
 const body=Buffer.from(message.body).toString('base64').match(/.{1,76}/g)?.join('\r\n')??'';
 return [`From: ${message.sender}`,`To: ${message.recipient}`,`Subject: ${subject}`,`Message-ID: <${message.id}@kavaroutes.com>`,`Date: ${new Date(message.created).toUTCString()}`,'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',''+body].join('\r\n');
}
export async function gmailTransport(message,settings,fetcher=fetch){
 let tokenResponse;try{tokenResponse=await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:settings.clientId,client_secret:settings.clientSecret,refresh_token:settings.refreshToken,grant_type:'refresh_token'})});}catch{throw Object.assign(new Error('GMAIL_TOKEN_TEMPORARY'),{retryable:true});}
 if(!tokenResponse.ok)throw Object.assign(new Error('GMAIL_RECONNECT_REQUIRED'),{retryable:tokenResponse.status===429||tokenResponse.status>=500});
 const token=await tokenResponse.json();if(!token.access_token)throw Object.assign(new Error('GMAIL_RECONNECT_REQUIRED'),{retryable:false});
 const raw=Buffer.from(gmailMime(message)).toString('base64url');let response;
 try{response=await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({raw})});}catch{throw Object.assign(new Error('GMAIL_SEND_UNCONFIRMED'),{unknown:true});}
 if(!response.ok)throw Object.assign(new Error('GMAIL_SEND_REJECTED'),{unknown:response.status>=500,retryable:response.status===429});
 let result;try{result=await response.json();}catch{throw Object.assign(new Error('GMAIL_SEND_UNCONFIRMED'),{unknown:true});}if(typeof result.id!=='string'||!result.id)throw Object.assign(new Error('GMAIL_SEND_UNCONFIRMED'),{unknown:true});return result.id;
}
export async function processMail(s,config,{now=Date.now(),send=gmailTransport}={}){
 const settings=config.email;if(!settings?.enabled||settings.provider!=='gmail'||!settings.refreshToken||!settings.clientId||!settings.clientSecret||!settings.from)return;
 generateReminders(s,now);
 // Gmail has no send idempotency key: interrupted requests require manual Sent-folder review.
 s.run("UPDATE email_outbox SET status='UNKNOWN',last_error='CHECK_GMAIL_SENT_BEFORE_RESENDING' WHERE status='PROCESSING' AND locked_at<?",now-300000);
 for(const candidate of s.all("SELECT id FROM email_outbox WHERE status='QUEUED' AND scheduled_at<=? ORDER BY scheduled_at LIMIT 10",now)){
  if(s.get('SELECT count(*) AS n FROM email_outbox WHERE first_attempt>?',now-day).n>=200)break;
  const m=s.transaction(()=>{const m=s.get("SELECT * FROM email_outbox WHERE id=? AND status='QUEUED'",candidate.id);if(!m)return null;const b=customer(s,m.business_id);let reason=null;
   if(!b.email_enabled||b.status==='SUSPENDED')reason='CUSTOMER_EMAIL_DISABLED';
   else if(b.contact!==m.recipient)reason='CONTACT_CHANGED';
   else if(m.invoice_id&&s.get('SELECT status FROM invoices WHERE id=?',m.invoice_id)?.status!==(m.purpose==='RECEIPT'?'PAID':'ISSUED'))reason=m.purpose==='RECEIPT'?'INVOICE_NOT_PAID':'INVOICE_NO_LONGER_DUE';
   else if(m.rule_id&&!s.get('SELECT enabled FROM email_rules WHERE id=?',m.rule_id)?.enabled)reason='RULE_DISABLED';
   else if((m.first_attempt&&now-m.first_attempt>23*3600000)||(!m.first_attempt&&now-m.scheduled_at>day))reason='SEND_WINDOW_EXPIRED';
   else if(m.attempts>=5)reason='RETRY_LIMIT_REACHED';
   if(reason){s.run("UPDATE email_outbox SET status='SKIPPED',last_error=? WHERE id=?",reason,m.id);s.audit('scheduler','EMAIL_SKIPPED',m.id);return null;}
   s.run("UPDATE email_outbox SET status='PROCESSING',attempts=attempts+1,first_attempt=coalesce(first_attempt,?),locked_at=?,sender=coalesce(sender,?) WHERE id=?",now,now,settings.from,m.id);return s.get('SELECT * FROM email_outbox WHERE id=?',m.id);
  });if(!m)continue;
  try{const id=await send(m,settings);s.transaction(()=>{s.run("UPDATE email_outbox SET status='ACCEPTED',provider_id=?,last_error=NULL WHERE id=?",id,m.id);s.audit('scheduler','EMAIL_PROVIDER_ACCEPTED',m.id);});}
  catch(error){const retry=!error.unknown&&error.retryable===true&&m.attempts<5;s.run('UPDATE email_outbox SET status=?,scheduled_at=?,last_error=? WHERE id=?',error.unknown?'UNKNOWN':retry?'QUEUED':'FAILED',now+Math.min(3600000,60000*2**m.attempts),error.unknown?'CHECK_GMAIL_SENT_BEFORE_RESENDING':retry?'PROVIDER_TEMPORARY':error.message==='GMAIL_RECONNECT_REQUIRED'?'GMAIL_RECONNECT_REQUIRED':'PROVIDER_REJECTED',m.id);s.audit('scheduler',retry?'EMAIL_RETRY_SCHEDULED':'EMAIL_FAILED',m.id);}
 }
}
export function startMailWorker(store,config){let busy=false;const tick=async()=>{if(busy)return;busy=true;try{await processMail(store,config);}catch{adminStatus('ADMIN_EMAIL_WORKER_FAILED');}finally{busy=false;}};const timer=setInterval(tick,60000);timer.unref();return async()=>{clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,50));};}
