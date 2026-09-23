import {refreshCustomers} from './customers.js';
import {downloadCsv} from './csv.js';
import {costModel,defaults} from './cost-model.js';
const $=id=>document.getElementById(id),money=cents=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
const dollars=value=>money(Math.round(value*100));
let api,current,companies,view,subscriptionVersion;
function node(tag,text){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;}
function amount(value){if(!/^\d+(\.\d{1,2})?$/.test(value))throw new Error('Enter a positive amount with at most two decimal places.');const [whole,fraction='']=value.split('.');return Number(whole)*100+Number(fraction.padEnd(2,'0'));}
function status(message){$('finance-message').textContent=message;}
function bind(id,action){$(id).addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{await action(Object.fromEntries(new FormData(event.target)));await refreshFinance();await refreshCustomers();}catch(error){status(error.message.replaceAll('_',' '));}finally{button.disabled=false;}});}
function action(label,fn){const button=node('button',label);button.type='button';button.addEventListener('click',async()=>{button.disabled=true;try{await fn();await refreshFinance();await refreshCustomers();}catch(error){status(error.message.replaceAll('_',' '));}finally{button.disabled=false;}});return button;}
const invoiceNumber=item=>`KR-${String(item.number).padStart(6,'0')}`;
function invoiceRows(items){return [['Invoice','Business','Contact','Description','Period start','Period end','Due date','Status','Subtotal USD','Tax USD','Total USD','Paid date','Payment reference'],...items.map(i=>[invoiceNumber(i),i.business_name,i.contact,i.description,i.period_start,i.period_end,i.due_date,i.status,(i.subtotal_cents/100).toFixed(2),(i.tax_cents/100).toFixed(2),(i.total_cents/100).toFixed(2),i.payment_date,i.payment_reference])];}
export function setupFinance(options){({api,current,companies}=options);
 const today=new Date().toISOString().slice(0,10);$('finance-month').value=today.slice(0,7);
 for(const input of document.querySelectorAll('#invoice-form input[type=date], #expense-form input[type=date]'))input.value=today;
 $('invoice-form').dataset.request=crypto.randomUUID();$('expense-form').dataset.request=crypto.randomUUID();
 $('finance-month').addEventListener('change',()=>refreshFinance().catch(error=>status(error.message)));
 const select=$('subscription-business');select.addEventListener('change',()=>fillSubscription());
 bind('subscription-form',async data=>{await api('subscription',{businessId:data.businessId,monthlyCents:amount(data.monthly),status:data.status,version:subscriptionVersion});status('Subscription recorded. No automatic charge or customer-access change was made.');});
 bind('invoice-form',async data=>{await api('invoice',{...data,subtotalCents:amount(data.subtotal),taxCents:amount(data.tax),requestId:$('invoice-form').dataset.request});$('invoice-form').dataset.request=crypto.randomUUID();status('Draft invoice created. Use Issue to record it as receivable.');});
 bind('expense-form',async data=>{await api('expense',{...data,amountCents:amount(data.amount),requestId:$('expense-form').dataset.request});$('expense-form').dataset.request=crypto.randomUUID();status('Expense recorded.');});
 bind('usage-form',async data=>{const existing=view.usage.find(u=>u.business_id===data.businessId);await api('usage',{businessId:data.businessId,month:view.month,version:existing?.version,...Object.fromEntries(['drivers','officeUsers','trips','routeRequests','gpsUpdates'].map(key=>[key,Number(data[key])]))});status('Monthly usage recorded manually. No automatic telemetry was inferred.');});
 $('usage-business').addEventListener('change',fillUsage);
 $('export-usage').addEventListener('click',()=>{if(view)downloadCsv(`kavaroutes-usage-${view.month}.csv`,[['Month','Business','Plan','Drivers','Office users','Trips','Route requests','GPS updates','Source'],...view.usage.map(u=>[u.month,u.name,u.plan,u.drivers,u.office_users,u.trips,u.route_requests,u.gps_updates,u.source])]);});
 $('use-usage').addEventListener('click',()=>{
  if(!view?.usage.length){$('usage-coverage').textContent='Record monthly usage first. No automatic usage telemetry is connected yet.';return;}
  const days=Number($('model-form').elements.days.value);
  if(!(days>0))return;
  for(const [tier,predicate] of [['small',u=>u.plan==='STARTER'],['enterprise',u=>u.plan!=='STARTER']]){
   const rows=view.usage.filter(predicate);if(!rows.length)continue;
   for(const [suffix,field,divisor] of [['Drivers','drivers',1],['Office','office_users',1],['Trips','trips',days]])$('model-form').elements[`${tier}${suffix}`].value=(rows.reduce((sum,u)=>sum+u[field],0)/rows.length/divisor).toFixed(2);
  }
  const trips=view.usage.reduce((s,u)=>s+u.trips,0);if(trips)$('model-form').elements.routesPerTrip.value=(view.usage.reduce((s,u)=>s+u.route_requests,0)/trips).toFixed(3);
  $('usage-coverage').textContent=`Applied sample averages from ${view.usage.length} business records for ${view.month}; target business count and tier mix are unchanged. Unsampled tiers retain estimates. STARTER maps to small; GROWTH/ENTERPRISE map to enterprise. Counts are manually recorded, not verified telemetry.`;renderModel();
 });
 for(const kind of ['invoices','expenses','subscriptions','summary'])$(`export-${kind}`).addEventListener('click',()=>{
  if(!view)return;
  const rows=kind==='invoices'?invoiceRows(view.invoices):kind==='expenses'?[['Date','Category','Vendor','Description','Amount USD','Status'],...view.expenses.map(e=>[e.spent_on,e.category,e.vendor,e.description,(e.amount_cents/100).toFixed(2),e.status])]:kind==='subscriptions'?[['Business','Status','Monthly USD'],...view.subscriptions.map(s=>[s.name,s.status,(s.monthly_cents/100).toFixed(2)])]:[['Month',view.month],['Metric','USD'],...Object.entries(view.summary).filter(([k])=>k.endsWith('Cents')).map(([k,v])=>[k.replace('Cents',''),(v/100).toFixed(2)]),['Active subscriptions',view.summary.activeSubscriptions]];
  downloadCsv(`kavaroutes-${kind}-${view.month}.csv`,rows);
 });
 const labels={businesses:'Business subscriptions',enterprisePercent:'Enterprise share %',smallDrivers:'Small: drivers',smallOffice:'Small: office users',smallTrips:'Small: trips/day',enterpriseDrivers:'Enterprise: drivers',enterpriseOffice:'Enterprise: office users',enterpriseTrips:'Enterprise: trips/day',days:'Operating days/month',hours:'Operating hours/day',gpsSeconds:'GPS upload interval (seconds)',officeRequestsPerMinute:'API reads/office user/minute',peakMultiplier:'Peak traffic multiplier',smallPrice:'Small subscription USD/month',enterprisePrice:'Enterprise USD/month',fixedMonthly:'Shared overhead USD/month',otherPerBusiness:'Other variable USD/business',supportHourly:'Support labor USD/hour',smallSupportHours:'Small support hours/month',enterpriseSupportHours:'Enterprise support hours/month',routesPerTrip:'Route requests/trip',geocodesPerTrip:'Geocoding requests/trip',mapLoadsPerOfficeDay:'Map loads/office user/day',paymentPercent:'Payment + billing fees %',paymentFixed:'Fixed payment fee USD',targetMargin:'Target operating margin %'};
 for(const [key,value]of Object.entries(defaults)){const label=node('label',labels[key]),input=node('input');input.name=key;input.type='number';input.min='0';input.step='any';input.value=value;label.append(input);$('model-inputs').append(label);}
 $('model-form').addEventListener('input',renderModel);$('model-form').addEventListener('submit',event=>{event.preventDefault();renderModel();});
 $('model-export').addEventListener('click',()=>{try{const inputs=modelInputs(),result=costModel(inputs);downloadCsv('kavaroutes-subscription-scenario.csv',[['Planning scenario, not measured capacity'],['Input','Value'],...Object.entries(inputs),[],['Output','Value'],...Object.entries(result)]);}catch(error){$('model-results').textContent=error.message;}});
 renderModel();
}
function modelInputs(){return Object.fromEntries([...new FormData($('model-form'))].map(([key,value])=>[key,Number(value)]));}
function renderModel(){try{const r=costModel(modelInputs());$('model-results').replaceChildren();
 for(const [label,value]of [['Monthly revenue',dollars(r.revenue)],['Operating costs before fees',dollars(r.baseCosts)],['Payment/billing fees',dollars(r.fees)],['Estimated operating surplus',`${dollars(r.profit)} (${r.margin.toFixed(1)}%)`],['Average break-even subscription',dollars(r.averageFloor)],['Average price at target margin',dollars(r.targetPrice)],['Small / enterprise target price',`${dollars(r.smallTarget)} / ${dollars(r.enterpriseTarget)}`],['Estimated Maps costs',dollars(r.maps)],['Modeled peak API requests/sec',r.estimatedPeakRps.toFixed(1)],['Potential concurrent sockets',r.concurrentSockets.toLocaleString()],['Monthly GPS updates',Math.round(r.gpsEventsMonthly).toLocaleString()],['Monthly trips',r.tripsMonthly.toLocaleString()]]){const item=node('div');item.append(node('span',label),node('strong',value));$('model-results').append(item);}
 }catch(error){$('model-results').textContent=error.message;}}
function fillSubscription(){const saved=view?.subscriptions.find(s=>s.business_id===$('subscription-business').value);subscriptionVersion=saved?.version;const form=$('subscription-form');form.elements.monthly.value=((saved?.monthly_cents??0)/100).toFixed(2);form.elements.status.value=saved?.status??'TRIAL';}
function fillUsage(){const saved=view?.usage.find(u=>u.business_id===$('usage-business').value),form=$('usage-form');for(const [name,key]of [['drivers','drivers'],['officeUsers','office_users'],['trips','trips'],['routeRequests','route_requests'],['gpsUpdates','gps_updates']])form.elements[name].value=saved?.[key]??0;}
export async function refreshFinance(){if(!current())return;view=await api('accounting',{month:$('finance-month').value});
 for(const select of document.querySelectorAll('.business-select')){const selected=select.value;select.replaceChildren();for(const b of companies()){const option=node('option',b.name);option.value=b.id;select.append(option);}if(companies().some(b=>b.id===selected))select.value=selected;}
 fillSubscription();
 fillUsage();$('usage-coverage').textContent=`${view.usage.length} of ${companies().length} business records have manually recorded usage for ${view.month}. No automatic metering is connected yet.`;
 $('finance-summary').replaceChildren();for(const [label,key]of [['Current MRR','mrrCents'],['Cash received this month','receivedCents'],['Expenses this month','spentCents'],['Cash surplus this month','cashSurplusCents'],['All unpaid issued invoices','outstandingCents'],['All overdue invoices','overdueCents']]){const box=node('section');box.className='card';box.append(node('span',label),node('strong',money(view.summary[key])));$('finance-summary').append(box);}
 $('invoice-rows').replaceChildren();for(const invoice of view.invoices){const row=node('tr');for(const value of [invoiceNumber(invoice),invoice.business_name,invoice.due_date,invoice.status,money(invoice.total_cents)])row.append(node('td',value));const controls=node('td');controls.append(action('CSV',()=>downloadCsv(`${invoiceNumber(invoice)}.csv`,invoiceRows([invoice]))));
  if(current().role==='OWNER'){
   if(invoice.status==='DRAFT')controls.append(action('Issue',async()=>{await api('invoice-status',{id:invoice.id,version:invoice.version,status:'ISSUED'});status('Invoice issued. Enabled email rules will handle reminders; no card is charged.');}));
   if(invoice.status==='ISSUED')controls.append(action('Record payment',async()=>{const paymentReference=prompt('Payment reference (confirm funds were received before recording; does not charge a card):');if(!paymentReference)return;const paymentDate=prompt('Payment date YYYY-MM-DD:',new Date().toISOString().slice(0,10));if(!paymentDate)return;await api('invoice-status',{id:invoice.id,version:invoice.version,status:'PAID',paymentReference,paymentDate});status('Payment recorded. Enabled payment receipt rules queue a receipt for email-enabled customers.');}));
   if(['DRAFT','ISSUED'].includes(invoice.status))controls.append(action('Void',async()=>{if(confirm(`Void ${invoiceNumber(invoice)}?`))await api('invoice-status',{id:invoice.id,version:invoice.version,status:'VOID'});}));
  }row.append(controls);$('invoice-rows').append(row);}
 $('expense-rows').replaceChildren();for(const expense of view.expenses){const row=node('tr');for(const value of [expense.spent_on,expense.category,expense.vendor,money(expense.amount_cents),expense.status])row.append(node('td',value));const controls=node('td');if(current().role==='OWNER'&&expense.status==='RECORDED')controls.append(action('Void',async()=>{if(confirm('Void this expense record?'))await api('expense-void',{id:expense.id});}));row.append(controls);$('expense-rows').append(row);}
 $('subscription-rows').replaceChildren();for(const s of view.subscriptions){const row=node('tr');for(const value of [s.name,s.status,money(s.monthly_cents)])row.append(node('td',value));$('subscription-rows').append(row);}
}
