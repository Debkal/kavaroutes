import { enqueuePaymentReceipts } from './customer-mail.mjs';
import { randomUUID } from 'node:crypto';
const error=(code,status=400)=>{throw Object.assign(new Error(code),{code,status});};
const text=(value,max=200)=>{if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))error('INVALID_ACCOUNTING_FIELD');return value.trim();};
export function cents(value){if(!Number.isSafeInteger(value)||value<0||value>100_000_000)error('INVALID_AMOUNT_CENTS');return value;}
export function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)error('INVALID_DATE');return value;}
export function initAccounting(store){store.db.exec(`
 CREATE TABLE IF NOT EXISTS subscriptions(business_id TEXT PRIMARY KEY REFERENCES businesses(id),monthly_cents INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('TRIAL','ACTIVE','PAUSED','CANCELED')),version INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,business_id TEXT NOT NULL REFERENCES businesses(id),business_name TEXT NOT NULL,contact TEXT NOT NULL,description TEXT NOT NULL,period_start TEXT NOT NULL,period_end TEXT NOT NULL,due_date TEXT NOT NULL,subtotal_cents INTEGER NOT NULL,tax_cents INTEGER NOT NULL,total_cents INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('DRAFT','ISSUED','PAID','VOID')),payment_date TEXT,payment_reference TEXT,created INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,request_id TEXT UNIQUE NOT NULL);
 CREATE TABLE IF NOT EXISTS expenses(id TEXT PRIMARY KEY,spent_on TEXT NOT NULL,category TEXT NOT NULL,vendor TEXT NOT NULL,description TEXT NOT NULL,amount_cents INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('RECORDED','VOID')),created INTEGER NOT NULL,request_id TEXT UNIQUE NOT NULL);
 CREATE INDEX IF NOT EXISTS invoice_period ON invoices(period_start);
 CREATE INDEX IF NOT EXISTS expense_date ON expenses(spent_on);
 CREATE TABLE IF NOT EXISTS usage_months(business_id TEXT NOT NULL REFERENCES businesses(id),month TEXT NOT NULL,drivers INTEGER NOT NULL,office_users INTEGER NOT NULL,trips INTEGER NOT NULL,route_requests INTEGER NOT NULL,gps_updates INTEGER NOT NULL,source TEXT NOT NULL DEFAULT 'MANUAL',version INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(business_id,month));
 `);}
function business(store,id){const row=store.get('SELECT * FROM businesses WHERE id=?',text(id,36));if(!row)error('BUSINESS_NOT_FOUND',404);return row;}
function requestId(value){if(typeof value!=='string'||! /^[a-f0-9-]{36}$/.test(value))error('REQUEST_ID_REQUIRED');return value;}
export function saveSubscription(store,actor,data){
 const company=business(store,data.businessId);cents(data.monthlyCents);
 if(!['TRIAL','ACTIVE','PAUSED','CANCELED'].includes(data.status))error('INVALID_SUBSCRIPTION_STATUS');
 return store.transaction(()=>{const existing=store.get('SELECT * FROM subscriptions WHERE business_id=?',company.id);
  if(existing && data.version!==existing.version)error('SUBSCRIPTION_CHANGED_RELOAD',409);
  store.run(`INSERT INTO subscriptions VALUES(?,?,?,1,?) ON CONFLICT(business_id) DO UPDATE SET monthly_cents=excluded.monthly_cents,status=excluded.status,version=version+1,updated=excluded.updated`,company.id,data.monthlyCents,data.status,Date.now());
  store.audit(actor,'SUBSCRIPTION_RECORDED',company.id);return {ok:true};
 });
}
export function createInvoice(store,actor,data){
 const company=business(store,data.businessId),request=requestId(data.requestId);
 const description=text(data.description),start=date(data.periodStart),end=date(data.periodEnd),due=date(data.dueDate);
 if(end<start)error('INVALID_PERIOD');const subtotal=cents(data.subtotalCents),tax=cents(data.taxCents),total=cents(subtotal+tax);if(total===0)error('INVOICE_AMOUNT_REQUIRED');
 return store.transaction(()=>{
  const existing=store.get('SELECT * FROM invoices WHERE request_id=?',request);
  if(existing){if(existing.business_id!==company.id||existing.description!==description||existing.period_start!==start||existing.period_end!==end||existing.due_date!==due||existing.subtotal_cents!==subtotal||existing.tax_cents!==tax)error('REQUEST_ID_REUSED',409);return {id:existing.id};}
  const id=randomUUID(),number=store.get('SELECT coalesce(max(number),0)+1 AS n FROM invoices').n;
  store.run(`INSERT INTO invoices(id,number,business_id,business_name,contact,description,period_start,period_end,due_date,subtotal_cents,tax_cents,total_cents,status,created,request_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?)`,id,number,company.id,company.name,company.contact,description,start,end,due,subtotal,tax,total,Date.now(),request);
  store.audit(actor,'INVOICE_DRAFT_CREATED',id);return {id};
 });
}
export function changeInvoice(store,actor,data){return store.transaction(()=>{
 const invoice=store.get('SELECT * FROM invoices WHERE id=?',text(data.id,36));if(!invoice)error('INVOICE_NOT_FOUND',404);
 if(invoice.version!==data.version)error('INVOICE_CHANGED_RELOAD',409);
 const allowed={DRAFT:['ISSUED','VOID'],ISSUED:['PAID','VOID'],PAID:[],VOID:[]};
 if(!allowed[invoice.status].includes(data.status))error('INVALID_INVOICE_TRANSITION',409);
 const paid=data.status==='PAID'?date(data.paymentDate):null,reference=data.status==='PAID'?text(data.paymentReference,120):null;
 if(paid && paid>new Date().toISOString().slice(0,10))error('FUTURE_PAYMENT_DATE');
 store.run('UPDATE invoices SET status=?,payment_date=?,payment_reference=?,version=version+1 WHERE id=?',data.status,paid,reference,invoice.id);
 if(data.status==='PAID')enqueuePaymentReceipts(store,invoice.id);
 store.audit(actor,`INVOICE_${data.status}`,invoice.id);return {ok:true};
});}
export function createExpense(store,actor,data){
 const day=date(data.spentOn),vendor=text(data.vendor,120),description=text(data.description),amount=cents(data.amountCents),request=requestId(data.requestId);
 if(!['HOSTING','MAPS','MESSAGING','SUPPORT','SOFTWARE','INSURANCE','OTHER'].includes(data.category)||amount===0)error('INVALID_EXPENSE');
 return store.transaction(()=>{const existing=store.get('SELECT * FROM expenses WHERE request_id=?',request);
  if(existing){if(existing.spent_on!==day||existing.vendor!==vendor||existing.description!==description||existing.amount_cents!==amount||existing.category!==data.category)error('REQUEST_ID_REUSED',409);return {id:existing.id};}
  const id=randomUUID();store.run("INSERT INTO expenses VALUES(?,?,?,?,?,?,'RECORDED',?,?)",id,day,data.category,vendor,description,amount,Date.now(),request);store.audit(actor,'EXPENSE_RECORDED',id);return {id};
 });
}
export function voidExpense(store,actor,data){return store.transaction(()=>{
 if(!store.run("UPDATE expenses SET status='VOID' WHERE id=? AND status='RECORDED'",text(data.id,36)).changes)error('EXPENSE_NOT_ACTIVE',409);
 store.audit(actor,'EXPENSE_VOIDED',data.id);return {ok:true};
});}
export function accountingView(store,month){
 if(typeof month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))error('INVALID_MONTH');
 const prefix=`${month}%`,today=new Date().toISOString().slice(0,10);
 const summary=store.get(`SELECT
 (SELECT coalesce(sum(monthly_cents),0) FROM subscriptions WHERE status='ACTIVE') AS mrrCents,
 (SELECT count(*) FROM subscriptions WHERE status='ACTIVE') AS activeSubscriptions,
 (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE status='PAID' AND payment_date LIKE ?) AS receivedCents,
 (SELECT coalesce(sum(amount_cents),0) FROM expenses WHERE status='RECORDED' AND spent_on LIKE ?) AS spentCents,
 (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE status='ISSUED') AS outstandingCents,
 (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE status='ISSUED' AND due_date<?) AS overdueCents`,prefix,prefix,today);
 return {month,summary:{...summary,cashSurplusCents:summary.receivedCents-summary.spentCents},
  subscriptions:store.all('SELECT s.*,b.name FROM subscriptions s JOIN businesses b ON b.id=s.business_id ORDER BY b.name LIMIT 1000'),
  invoices:store.all('SELECT * FROM invoices WHERE period_start LIKE ? ORDER BY number DESC LIMIT 1000',prefix),
  expenses:store.all('SELECT * FROM expenses WHERE spent_on LIKE ? ORDER BY spent_on DESC,created DESC LIMIT 1000',prefix),
  usage:store.all('SELECT u.*,b.name,b.plan FROM usage_months u JOIN businesses b ON b.id=u.business_id WHERE month=? ORDER BY b.name LIMIT 1000',month),
  displayLimit:1000};
}
export function recordUsage(store,actor,data){
 business(store,data.businessId);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month??''))error('INVALID_MONTH');
 for(const key of ['drivers','officeUsers','trips','routeRequests','gpsUpdates'])if(!Number.isSafeInteger(data[key])||data[key]<0||data[key]>100_000_000)error('INVALID_USAGE_COUNT');
 return store.transaction(()=>{const previous=store.get('SELECT version FROM usage_months WHERE business_id=? AND month=?',data.businessId,data.month);if(previous&&previous.version!==data.version)error('USAGE_CHANGED_RELOAD',409);
 store.run(`INSERT INTO usage_months(business_id,month,drivers,office_users,trips,route_requests,gps_updates) VALUES(?,?,?,?,?,?,?) ON CONFLICT(business_id,month) DO UPDATE SET drivers=excluded.drivers,office_users=excluded.office_users,trips=excluded.trips,route_requests=excluded.route_requests,gps_updates=excluded.gps_updates,version=version+1`,data.businessId,data.month,data.drivers,data.officeUsers,data.trips,data.routeRequests,data.gpsUpdates);
 store.audit(actor,'MONTHLY_USAGE_RECORDED',data.businessId);return {ok:true};});
}
