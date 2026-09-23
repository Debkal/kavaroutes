import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openStore} from '../src/store.mjs';
import {accountingView,saveSubscription,createInvoice,changeInvoice,createExpense,voidExpense,recordUsage} from '../src/accounting.mjs';
import {csvBody,csvCell} from '../public/csv.js';
import {costModel,defaults,mapsTierCost} from '../public/cost-model.js';
function fixture(t){const store=openStore(':memory:');t.after(()=>store.close());const id=randomUUID();store.run('INSERT INTO businesses VALUES(?,?,?,?,?,1,?,?)',id,'Example NEMT','billing@example.com','ACTIVE','STARTER',Date.now(),Date.now());return {store,id};}
function invoiceData(id){return {businessId:id,description:'Subscription',periodStart:'2026-09-01',periodEnd:'2026-09-30',dueDate:'2026-09-15',subtotalCents:19900,taxCents:1000,requestId:randomUUID()};}
test('invoice lifecycle is immutable, idempotent, audited and cash reporting uses payment month',t=>{
 const {store,id}=fixture(t),data=invoiceData(id),created=createInvoice(store,'owner',data);
 assert.equal(createInvoice(store,'owner',data).id,created.id);
 assert.throws(()=>createInvoice(store,'owner',{...data,subtotalCents:1}),/REQUEST_ID_REUSED/);
 assert.throws(()=>changeInvoice(store,'owner',{id:created.id,version:1,status:'PAID',paymentDate:'2026-09-10',paymentReference:'reference'}),/INVALID_INVOICE_TRANSITION/);
 changeInvoice(store,'owner',{id:created.id,version:1,status:'ISSUED'});
 assert.equal(accountingView(store,'2026-09').summary.outstandingCents,20900);
 assert.throws(()=>changeInvoice(store,'owner',{id:created.id,version:1,status:'VOID'}),/INVOICE_CHANGED_RELOAD/);
 changeInvoice(store,'owner',{id:created.id,version:2,status:'PAID',paymentDate:'2026-08-31',paymentReference:'bank-123'});
 assert.equal(accountingView(store,'2026-09').summary.receivedCents,0);
 assert.equal(accountingView(store,'2026-08').summary.receivedCents,20900);
 assert.equal(accountingView(store,'2026-09').summary.outstandingCents,0);
 assert.throws(()=>changeInvoice(store,'owner',{id:created.id,version:3,status:'VOID'}),/INVALID_INVOICE_TRANSITION/);
 store.run('UPDATE businesses SET name=? WHERE id=?','Renamed customer',id);
 assert.equal(accountingView(store,'2026-09').invoices[0].business_name,'Example NEMT');
 assert.equal(store.all("SELECT * FROM audit WHERE action='INVOICE_PAID'").length,1);
});
test('expenses, subscription state/version, and usage sample remain separate from invoiced revenue',t=>{
 const {store,id}=fixture(t);saveSubscription(store,'owner',{businessId:id,monthlyCents:19900,status:'ACTIVE'});
 assert.equal(accountingView(store,'2026-09').summary.mrrCents,19900);
 assert.equal(accountingView(store,'2026-09').summary.receivedCents,0);
 assert.throws(()=>saveSubscription(store,'owner',{businessId:id,monthlyCents:20000,status:'ACTIVE',version:0}),/SUBSCRIPTION_CHANGED_RELOAD/);
 saveSubscription(store,'owner',{businessId:id,monthlyCents:19900,status:'PAUSED',version:1});
 assert.equal(accountingView(store,'2026-09').summary.mrrCents,0);
 const data={spentOn:'2026-09-01',category:'HOSTING',vendor:'Cloud',description:'VM',amountCents:3000,requestId:randomUUID()};
 const expense=createExpense(store,'owner',data);assert.equal(createExpense(store,'owner',data).id,expense.id);
 assert.equal(accountingView(store,'2026-09').summary.cashSurplusCents,-3000);
 voidExpense(store,'owner',{id:expense.id});assert.equal(accountingView(store,'2026-09').summary.spentCents,0);
 assert.throws(()=>voidExpense(store,'owner',{id:expense.id}),/EXPENSE_NOT_ACTIVE/);
 const usage={businessId:id,month:'2026-09',drivers:3,officeUsers:2,trips:999,routeRequests:1900,gpsUpdates:10000};recordUsage(store,'owner',usage);
 assert.equal(accountingView(store,'2026-09').usage[0].trips,999);
 assert.throws(()=>recordUsage(store,'owner',usage),/USAGE_CHANGED_RELOAD/);
 recordUsage(store,'owner',{...usage,trips:1500,version:1});assert.equal(accountingView(store,'2026-09').usage[0].trips,1500);
});
test('invalid money, impossible dates, unbounded strings and unknown businesses are rejected',t=>{
 const {store,id}=fixture(t);for(const invalid of [-1,1.1,Infinity,NaN,'19900',100000001])assert.throws(()=>createInvoice(store,'owner',{...invoiceData(id),subtotalCents:invalid}),/INVALID_AMOUNT/);
 assert.throws(()=>createInvoice(store,'owner',{...invoiceData(id),periodStart:'2026-02-30'}),/INVALID_DATE/);
 assert.throws(()=>createInvoice(store,'owner',{...invoiceData(id),businessId:randomUUID()}),/BUSINESS_NOT_FOUND/);
 assert.throws(()=>createInvoice(store,'owner',{...invoiceData(id),description:'x'.repeat(201)}),/INVALID_ACCOUNTING_FIELD/);
});
test('CSV neutralizes whitespace-prefixed formulas and escapes multiline/quoted values',()=>{
 for(const value of ['=1+1',' +cmd','\t=1','\r@SUM(A1)','\uFEFF-1'])assert.ok(csvCell(value).startsWith('"\''));
 assert.equal(csvCell('A,"B"\nC'),'"A,""B""\nC"');assert.equal(csvCell(100),'"100"');assert.ok(csvBody([['a','b'],[1,2]]).includes('\r\n'));
});
test('100-business pricing model allocates shared caps once and solves payment-adjusted break-even',()=>{
 assert.equal(mapsTierCost(10000,5),0);assert.equal(mapsTierCost(100000,5),450);assert.equal(mapsTierCost(200000,5),850);
 assert.ok(Math.abs(mapsTierCost(6000000,7)-mapsTierCost(5000000,7)-530)<1e-8);
 const r=costModel(defaults);assert.equal(r.small+r.enterprise,100);assert.equal(r.tripsMonthly,44000);
 const atFloor=costModel({...defaults,smallPrice:r.averageFloor,enterprisePrice:r.averageFloor});assert.ok(Math.abs(atFloor.profit)<1e-8);
 const atTarget=costModel({...defaults,smallPrice:r.smallTarget,enterprisePrice:r.enterpriseTarget});assert.ok(Math.abs(atTarget.margin-defaults.targetMargin)<1e-8);
 assert.ok(costModel({...defaults,smallTrips:500}).tripsMonthly>r.tripsMonthly);
 assert.ok(costModel({...defaults,officeRequestsPerMinute:2}).estimatedPeakRps<r.estimatedPeakRps);
 assert.throws(()=>costModel({...defaults,targetMargin:99}),/Check/);
});
