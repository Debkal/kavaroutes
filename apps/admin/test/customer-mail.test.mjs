import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from '../src/store.mjs';
import {saveCustomer,saveTemplate,previewEmail,queueEmail,cancelEmail,saveRule,generateReminders,processMail,mailView,gmailTransport,gmailMime} from '../src/customer-mail.mjs';
import {createInvoice,changeInvoice} from '../src/accounting.mjs';
const config={email:{provider:'gmail',enabled:true,from:'kavasupport@kavaroutes.com',clientId:'test-client',clientSecret:'test-secret',refreshToken:'test-refresh'}};
function fixture(t){const s=openStore(':memory:');s.run("UPDATE email_rules SET enabled=0");t.after(()=>s.close());const id=randomUUID();s.run('INSERT INTO businesses VALUES(?,?,?,?,?,1,?,?)',id,'Customer Example','customer@example.com','ACTIVE','STARTER',Date.now(),Date.now());saveCustomer(s,'owner',{businessId:id,contactName:'Casey',phone:'123',notes:'Billing contact',emailEnabled:true});const template=saveTemplate(s,'owner',{name:'General',subject:'Hello {{contact_name}}',body:'A message for {{business_name}}.'}).id;return {s,id,template};}
function draft(f){return previewEmail(f.s,'owner',{businessId:f.id,templateId:f.template});}
function invoice(f){const today=new Date().toISOString().slice(0,10);const i=createInvoice(f.s,'owner',{businessId:f.id,description:'Monthly subscription',periodStart:today,periodEnd:today,dueDate:today,subtotalCents:19900,taxCents:0,requestId:randomUUID()});changeInvoice(f.s,'owner',{id:i.id,version:1,status:'ISSUED'});return i.id;}
test('template validation, personalisation, immutable preview and queue ownership',t=>{
 const f=fixture(t),p=draft(f);assert.equal(p.subject,'Hello Casey');assert.equal(p.recipient,'customer@example.com');
 assert.throws(()=>saveTemplate(f.s,'owner',{name:'bad',subject:'{{unknown}}',body:'Body'}),/UNKNOWN_TEMPLATE_VARIABLE/);
 assert.throws(()=>saveTemplate(f.s,'owner',{name:'bad',subject:'Hi\r\nBcc: test@example.com',body:'Body'}),/INVALID_EMAIL_FIELD/);
 assert.throws(()=>queueEmail(f.s,'other',{id:p.id,scheduledAt:null}),/PREVIEW_AGAIN/);
 saveTemplate(f.s,'owner',{id:f.template,version:1,name:'General',subject:'Edited',body:'Edited message'});
 queueEmail(f.s,'owner',{id:p.id,scheduledAt:null});assert.equal(f.s.get('SELECT subject FROM email_outbox WHERE id=?',p.id).subject,'Hello Casey');
 assert.throws(()=>queueEmail(f.s,'owner',{id:p.id,scheduledAt:null}),/PREVIEW_AGAIN/);
 cancelEmail(f.s,'owner',{id:p.id});assert.equal(f.s.get('SELECT status FROM email_outbox WHERE id=?',p.id).status,'CANCELED');
 assert.throws(()=>saveCustomer(f.s,'owner',{businessId:f.id,contactName:'New',phone:'',notes:'',emailEnabled:true,version:0}),/CUSTOMER_CHANGED_RELOAD/);
});
test('invoice rules deduplicate, skip paid invoices at dispatch, and pause pending mail',async t=>{
 const f=fixture(t),i=invoice(f);const template=saveTemplate(f.s,'owner',{name:'Invoice due',subject:'{{invoice_number}} is due',body:'Hello {{contact_name}}, {{amount_due}} is due {{due_date}}.'}).id;
 assert.throws(()=>previewEmail(f.s,'owner',{businessId:f.id,templateId:template}),/SELECT_INVOICE/);
 const rule=saveRule(f.s,'owner',{name:'Due today',templateId:template,offsetDays:0,hourUtc:0,enabled:true}).id;
 generateReminders(f.s);generateReminders(f.s);assert.equal(f.s.get('SELECT count(*) AS n FROM email_outbox').n,1);
 assert.ok(f.s.get('SELECT body FROM email_outbox').body.includes('$199.00'));
 changeInvoice(f.s,'owner',{id:i,version:2,status:'PAID',paymentDate:new Date().toISOString().slice(0,10),paymentReference:'paid'});
 let calls=0;await processMail(f.s,config,{send:async()=>{calls++;return 'provider-id';}});assert.equal(calls,0);assert.equal(f.s.get('SELECT last_error FROM email_outbox').last_error,'INVOICE_NO_LONGER_DUE');
 invoice(f);generateReminders(f.s);saveRule(f.s,'owner',{id:rule,version:1,name:'Due today',templateId:template,offsetDays:0,hourUtc:0,enabled:false});assert.equal(f.s.get("SELECT count(*) AS n FROM email_outbox WHERE status='QUEUED'").n,0);
});
test('disabled delivery does not send; contact changes and preferences prevent queued sends',async t=>{
 const f=fixture(t),p=draft(f);queueEmail(f.s,'owner',{id:p.id,scheduledAt:null});let calls=0;const send=async()=>{calls++;return 'provider-id';};
 await processMail(f.s,{}, {send});assert.equal(calls,0);
 assert.equal(mailView(f.s,config).deliveryConfigured,true);assert.ok(!JSON.stringify(mailView(f.s,config)).includes('test-secret'));
 f.s.run('UPDATE businesses SET contact=? WHERE id=?','new@example.com',f.id);await processMail(f.s,config,{send});assert.equal(calls,0);assert.equal(f.s.get('SELECT last_error FROM email_outbox').last_error,'CONTACT_CHANGED');
 const next=draft(f);queueEmail(f.s,'owner',{id:next.id,scheduledAt:null});saveCustomer(f.s,'owner',{businessId:f.id,contactName:'Casey',phone:'',notes:'',emailEnabled:false,version:1});await processMail(f.s,config,{send});assert.equal(calls,0);
});
test('future schedules wait, worker claims once, and ambiguous Gmail sends are not retried',async t=>{
 const f=fixture(t),p=draft(f),now=Date.now();queueEmail(f.s,'owner',{id:p.id,scheduledAt:new Date(now+3600000).toISOString()});let calls=0;const send=async()=>{calls++;return 'provider-id';};
 await processMail(f.s,config,{now,send});assert.equal(calls,0);await Promise.all([processMail(f.s,config,{now:now+3600001,send}),processMail(f.s,config,{now:now+3600001,send})]);assert.equal(calls,1);assert.equal(f.s.get('SELECT status FROM email_outbox WHERE id=?',p.id).status,'ACCEPTED');
 const next=draft(f);queueEmail(f.s,'owner',{id:next.id,scheduledAt:null});await processMail(f.s,config,{send:async()=>{throw Object.assign(Error('timeout'),{unknown:true});}});assert.equal(f.s.get('SELECT status FROM email_outbox WHERE id=?',next.id).status,'UNKNOWN');await processMail(f.s,config,{send});assert.equal(calls,1);
});
test('temporary token failures retry, stale messages expire, and interrupted sends require review',async t=>{
 const f=fixture(t),p=draft(f);queueEmail(f.s,'owner',{id:p.id,scheduledAt:null});await processMail(f.s,config,{send:async()=>{throw Object.assign(Error('token network'),{retryable:true});}});assert.equal(f.s.get('SELECT status FROM email_outbox').status,'QUEUED');
 f.s.run("UPDATE email_outbox SET status='PROCESSING',locked_at=?",Date.now()-600000);await processMail(f.s,config,{send:async()=>assert.fail('must not retry interrupted Gmail sends')});assert.equal(f.s.get('SELECT status FROM email_outbox').status,'UNKNOWN');
 const next=draft(f);queueEmail(f.s,'owner',{id:next.id,scheduledAt:null});f.s.run('UPDATE email_outbox SET scheduled_at=? WHERE id=?',Date.now()-2*86400000,next.id);await processMail(f.s,config,{send:async()=>assert.fail('expired')});assert.equal(f.s.get('SELECT last_error FROM email_outbox WHERE id=?',next.id).last_error,'SEND_WINDOW_EXPIRED');
});
test('Gmail transport creates encoded MIME and requests send endpoint without inbox access',async()=>{
 const m={id:randomUUID(),created:Date.now(),sender:config.email.from,recipient:'customer@example.com',subject:'Hello ✓',body:'Your invoice is due.'};const calls=[];
 const id=await gmailTransport(m,config.email,async(url,options)=>{calls.push([url,options]);return calls.length===1?{ok:true,json:async()=>({access_token:'test-access'})}:{ok:true,json:async()=>({id:'gmail-id'})};});assert.equal(id,'gmail-id');assert.equal(calls.length,2);assert.ok(calls[1][0].endsWith('/messages/send'));const raw=Buffer.from(JSON.parse(calls[1][1].body).raw,'base64url').toString();assert.ok(raw.includes('To: customer@example.com'));assert.ok(raw.includes(Buffer.from(m.body).toString('base64')));assert.throws(()=>gmailMime({...m,recipient:'victim@example.com\r\nBcc:x@y.com'}),/INVALID_MAIL_ADDRESS/);
 let n=0;await assert.rejects(()=>gmailTransport(m,config.email,async()=>{if(n++===0)return {ok:true,json:async()=>({access_token:'test'})};throw Error('network');}),e=>e.unknown===true);
});
test('recording payment atomically queues one personalized PAID receipt, never from an unpaid invoice',async t=>{
 const f=fixture(t),i=invoice(f);f.s.run("UPDATE email_rules SET enabled=1 WHERE kind='PAYMENT_RECEIVED'");
 assert.equal(f.s.get('SELECT count(*) AS n FROM email_outbox').n,0);
 const paymentDate=new Date().toISOString().slice(0,10);changeInvoice(f.s,'owner',{id:i,version:2,status:'PAID',paymentDate,paymentReference:'BANK-CONFIRMED-123'});
 const receipt=f.s.get('SELECT * FROM email_outbox');assert.equal(receipt.purpose,'RECEIPT');assert.equal(receipt.status,'QUEUED');assert.match(receipt.body,/Status: PAID/);assert.match(receipt.body,/Amount paid: \$199.00/);assert.ok(receipt.body.includes(paymentDate));assert.ok(receipt.body.includes('BANK-CONFIRMED-123'));
 assert.throws(()=>changeInvoice(f.s,'owner',{id:i,version:2,status:'PAID',paymentDate,paymentReference:'BANK-CONFIRMED-123'}),/CHANGED/);assert.equal(f.s.get('SELECT count(*) AS n FROM email_outbox').n,1);
 let sent=0;await processMail(f.s,config,{send:async m=>{sent++;assert.equal(m.purpose,'RECEIPT');return 'gmail-receipt-id';}});assert.equal(sent,1);assert.equal(f.s.get('SELECT status FROM email_outbox').status,'ACCEPTED');
});
test('bad reminder rendering is recorded without preventing another rule or rolling send budget',async t=>{
 const f=fixture(t),i=invoice(f);const bad=saveTemplate(f.s,'owner',{name:'Oversized result',subject:'{{business_name}}'.repeat(10),body:'Test'}).id;
 f.s.run('UPDATE businesses SET name=? WHERE id=?','x'.repeat(120),f.id);saveRule(f.s,'owner',{name:'Bad',templateId:bad,offsetDays:0,hourUtc:0,enabled:true});saveRule(f.s,'owner',{name:'Good',templateId:f.template,offsetDays:0,hourUtc:0,enabled:true});generateReminders(f.s);assert.equal(f.s.get("SELECT count(*) AS n FROM email_outbox WHERE status='FAILED'").n,1);assert.equal(f.s.get("SELECT count(*) AS n FROM email_outbox WHERE status='QUEUED'").n,1);
 const now=Date.now();for(let n=0;n<200;n++)f.s.run("INSERT INTO email_outbox(id,business_id,recipient,subject,body,status,scheduled_at,created,actor,first_attempt) VALUES(?,?,?,'Test','Test','ACCEPTED',?,?,'test',?)",randomUUID(),f.id,'customer@example.com',now,now,now);
 await processMail(f.s,config,{send:async()=>assert.fail('rolling daily budget must prevent dispatch')});assert.equal(f.s.get("SELECT count(*) AS n FROM email_outbox WHERE status='QUEUED'").n,1);
});
