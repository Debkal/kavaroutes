import {setupCustomers,refreshCustomers} from './customers.js';
import {setupFinance,refreshFinance} from './finance.js';
const $ = id => document.getElementById(id);
let csrf='', current=null, configuration, enrollment='', businesses=[], editing=null, selectedBusiness=null, challengeUrl='', manualCharges=[], editingCharge=null;
const message = text => { $('message').textContent=text; $('challenge-status').textContent=text; };
async function api(path,data={}) {
  const response=await fetch(`/api/${path}`,{method:'POST',credentials:'same-origin',signal:AbortSignal.timeout(path==='trip-report-send'?35000:15000),headers:{'Content-Type':'application/json','X-Admin-CSRF':csrf},body:JSON.stringify(data)});
  if (response.redirected || !response.headers.get('content-type')?.includes('application/json')) throw new Error('Your Cloudflare sign-in may have expired. Refresh the page and sign in again.');
  const result=await response.json();
  if (!response.ok) {
    if (response.status===401 && current) showLogin();
    const errors={AUTHENTICATION_FAILED:'Sign-in could not be verified. Use the same email as your Cloudflare login and its matching, current enrollment file.',TOO_MANY_ATTEMPTS:'Too many attempts. Wait five minutes before trying again.'};
    throw new Error(errors[result.error] ?? result.error ?? 'Request failed');
  }
  return result;
}
function download(name,text) {
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function file(input) {
  const selected=$(input).files[0];
  if (!selected || selected.size>24000) throw new Error('Select a valid JSON file smaller than 24 KB.');
  return JSON.parse(await selected.text());
}
function bind(id,fn) {
  $(id).addEventListener('submit',async event=>{
    event.preventDefault(); const buttons=[...event.target.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);message('Working…');
    try { await fn(); } catch(error) { message(error.message.replaceAll('_',' ')); }
    finally { buttons.forEach(button=>button.disabled=false); }
  });
}
function showLogin() {
  csrf='';current=null;enrollment='';selectedBusiness=null;manualCharges=[];editingCharge=null;$('business-workspace').hidden=true;$('qr').removeAttribute('src');
  $('login').hidden=false;$('dashboard').hidden=true;$('logout').hidden=true;
  $('proof-panel').hidden=true;$('enroll-panel').hidden=true;
  $('session-info').textContent='A signed challenge and authenticator code are required for every new session.';
}
async function signedIn(result) {
  current=result;csrf=result.csrf;enrollment='';$('qr').removeAttribute('src');
  $('login-code').value='';$('enroll-code').value='';$('invite-file').value='';$('response-file').value='';
  $('login').hidden=true;$('dashboard').hidden=false;$('logout').hidden=false;
  document.querySelectorAll('.owner-only').forEach(element=>element.hidden=current.role!=='OWNER');
  $('session-info').textContent=`${current.email} · ${current.role} · Session expires ${new Date(current.expires).toLocaleTimeString()}`;
  await refresh();
}
let loadedTripDay=null;
function tripReportStatus(result){
  if(result.emailStatus==='ACCEPTED')return `Report emailed to ${result.recipient}. Gmail accepted the message; inbox delivery is not confirmed.`;
  if(result.emailStatus==='UNKNOWN'||result.emailStatus==='PROCESSING')return 'An email attempt may be in progress or unconfirmed. Check Gmail Sent before trying again.';
  if(!result.emailReady)return 'Report ready. Connect and enable Gmail in Customer email before sending it to your admin address.';
  if(!result.eventCount)return 'No trip events are recorded yet. The report updates as the test runs.';
  return `Report updated ${new Date(result.updatedAt).toLocaleString()}. Review it below, then email it to ${result.recipient}.`;
}
async function loadTripReport(){
  if(current?.role!=='OWNER'||!selectedBusiness?.runtime_tenant_id)return;
  const day=$('trip-report-day').value;
  loadedTripDay=null;$('trip-report-send').disabled=true;$('trip-report-load').disabled=true;
  try{
    const result=await api('trip-report',{businessId:selectedBusiness.id,day});
    $('trip-report-text').textContent=result.text;$('trip-report-text').hidden=false;
    $('trip-report-status').textContent=tripReportStatus(result);
    loadedTripDay=day;
    $('trip-report-send').disabled=!result.emailReady||!result.eventCount||['ACCEPTED','UNKNOWN','PROCESSING'].includes(result.emailStatus);
  }catch(error){$('trip-report-text').hidden=true;$('trip-report-status').textContent=error.message==='TRIP_REPORT_NOT_FOUND'?'No trip log is available for this date yet.':error.message.replaceAll('_',' ');}
  finally{$('trip-report-load').disabled=false;}
}
const pacificDate=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
const datePart=type=>pacificDate.find(part=>part.type===type).value;
$('trip-report-day').value=`${datePart('year')}-${datePart('month')}-${datePart('day')}`;
$('trip-report-day').addEventListener('change',()=>{loadedTripDay=null;$('trip-report-send').disabled=true;$('trip-report-text').hidden=true;$('trip-report-status').textContent='Load the report for the selected service date.';});
$('trip-report-load').addEventListener('click',loadTripReport);
$('trip-report-send').addEventListener('click',async()=>{
  if(!selectedBusiness||!loadedTripDay||loadedTripDay!==$('trip-report-day').value)return;
  $('trip-report-send').disabled=true;
  try{await api('trip-report-send',{businessId:selectedBusiness.id,day:loadedTripDay});await loadTripReport();}
  catch(error){$('trip-report-status').textContent=error.message.replaceAll('_',' ');await loadTripReport();}
});
bind('challenge-form',async()=>{
  if (!configuration) throw new Error('Sign-in controls have not finished loading. Refresh the page and try again.');
  let invite='';const email=$('email').value.trim().toLowerCase();
  if ($('invite-file').files.length) { const selected=await file('invite-file');if(selected.email!==email)throw new Error('Enrollment file is for another email.');invite=selected.invite; }
  const result=await api('challenge',{email,invite});
  const id=JSON.parse(result.challenge).id;
  const name=`admin-challenge-${id}.json`;
  if(challengeUrl)URL.revokeObjectURL(challengeUrl);
  challengeUrl=URL.createObjectURL(new Blob([result.challenge],{type:'application/json'}));
  $('challenge-download').href=challengeUrl;$('challenge-download').download=name;
  download(name,result.challenge);
  $('proof-panel').hidden=false;$('enroll-panel').hidden=true;$('qr').removeAttribute('src');
  $('login-code-label').hidden=result.purpose==='enroll';$('login-code').required=result.purpose==='login';
  $('response-file').value='';
  const local=configuration.mode==='local'?' --origin http://127.0.0.1:58100':'';
  // Email is shown for reading only; commands must not interpolate untrusted shell metacharacters.
  $('sign-command').textContent=`node apps/admin/bin/signer.mjs sign --challenge "PATH_TO_DOWNLOADS/${name}" --email YOUR_EMAIL${local} --output "admin-response-${id}.json"`;
  message('Challenge downloaded. Replace YOUR_EMAIL and PATH_TO_DOWNLOADS in the command. If it expires, download a new challenge.');
});
bind('proof-form',async()=>{
  const result=await api('prove',{response:await file('response-file'),code:$('login-code').value});
  if(result.enrollment){enrollment=result.enrollment;$('qr').src=result.qr;$('enroll-panel').hidden=false;$('proof-panel').hidden=true;message('Signature verified. Scan the QR code, then enter the current authenticator code.');}
  else {await signedIn(result);message('Signed in with ML-DSA-65 and your authenticator.');}
});
bind('enroll-form',async()=>{await signedIn(await api('enroll',{enrollment,code:$('enroll-code').value}));message('Your signing key and authenticator are enrolled.');});
$('logout').addEventListener('click',async()=>{try{await api('logout');showLogin();message('Signed out.');}catch(error){message(error.message);}});
function cell(row,text){const element=document.createElement('td');element.textContent=text;row.append(element);return element;}
function renderBusinesses() {
  const query=$('search').value.toLowerCase();$('business-rows').replaceChildren();
  const filtered=businesses.filter(item=>`${item.name} ${item.contact}`.toLowerCase().includes(query));
  $('empty').hidden=filtered.length>0;
  $('empty').textContent=businesses.length?'No businesses match your search.':'No businesses yet. Add your first test business below.';
  for(const item of filtered){const row=document.createElement('tr');cell(row,item.name);cell(row,item.contact);cell(row,item.plan);
    const badge=document.createElement('span');badge.className=`badge ${item.status.toLowerCase()}`;badge.textContent=item.status;cell(row,'').append(badge);
    const action=cell(row,'');if(current.role==='OWNER'){const open=document.createElement('button');open.textContent='Workspace';open.addEventListener('click',()=>openBusinessWorkspace(item));action.append(open);const button=document.createElement('button');button.textContent='Edit';button.addEventListener('click',()=>{editing=item;for(const key of ['name','contact','plan','status'])$('business-form').elements.namedItem(key).value=item[key];$('editor-title').textContent='Edit business';$('business-editor').scrollIntoView({behavior:'smooth'});});action.append(button);}else action.textContent='Read only';
    $('business-rows').append(row);
  }
}
const dollars=cents=>`$${(cents/100).toFixed(2)}`;
function clearManualCharge(){
  editingCharge=null;$('manual-charge-form').reset();$('manual-charge-form').elements.namedItem('serviceDate').value=$('trip-report-day').value;
  $('manual-charge-title').textContent='Add manual route charge';
}
function renderManualCharges(){
  $('manual-charge-rows').replaceChildren();
  for(const item of manualCharges){
    const row=document.createElement('tr');
    cell(row,item.serviceDate);cell(row,`${item.title} · ${item.reference}`);cell(row,dollars(item.tripChargeCents));
    cell(row,`${dollars(item.waitingRateCentsPerHour)}/hr`);
    cell(row,item.billableWaitingMinutes===null?'Unconfirmed':`${item.billableWaitingMinutes} min`);
    const total=item.billableWaitingMinutes===null?null:item.tripChargeCents+Math.round(item.waitingRateCentsPerHour*item.billableWaitingMinutes/60);
    cell(row,total===null?'Pending wait confirmation':dollars(total));
    const action=cell(row,'');const button=document.createElement('button');button.type='button';button.textContent='Edit';
    button.addEventListener('click',()=>{
      editingCharge=item;const fields=$('manual-charge-form').elements;
      for(const key of ['serviceDate','reference','title','notes'])fields.namedItem(key).value=item[key];
      fields.namedItem('tripCharge').value=(item.tripChargeCents/100).toFixed(2);
      fields.namedItem('waitingRate').value=(item.waitingRateCentsPerHour/100).toFixed(2);
      fields.namedItem('billableWaitingMinutes').value=item.billableWaitingMinutes??'';
      fields.namedItem('passengerMiles').value=item.passengerMiles??'';
      fields.namedItem('insuranceMonthlyAssumption').value=item.insuranceMonthlyAssumptionCents===null?'':(item.insuranceMonthlyAssumptionCents/100).toFixed(2);
      $('manual-charge-title').textContent='Edit manual route charge';$('manual-charge-form').scrollIntoView({behavior:'smooth'});
    });action.append(button);$('manual-charge-rows').append(row);
  }
  if(!manualCharges.length)$('manual-charge-status').textContent='No manual route charges for this business yet.';
}
async function loadManualCharges(){
  const businessId=selectedBusiness?.id;if(!businessId)return;
  try{
    const result=await api('manual-route-charges',{businessId});
    if(selectedBusiness?.id!==businessId)return;
    manualCharges=result.events;renderManualCharges();
    if(manualCharges.length)$('manual-charge-status').textContent=`${manualCharges.length} manual route charge event${manualCharges.length===1?'':'s'} for this business.`;
  }catch(error){$('manual-charge-status').textContent=error.message.replaceAll('_',' ');}
}
function openBusinessWorkspace(item){
  selectedBusiness=item;loadedTripDay=null;
  $('workspace-title').textContent=`${item.name} · workspace`;
  $('workspace-status').textContent=item.runtime_tenant_id?`Business ID ${item.id}. Operations tenant ${item.runtime_tenant_id}.`:`Business ID ${item.id}. No operations workspace is linked to this account yet.`;
  $('workspace-links').hidden=!item.runtime_tenant_id;
  $('workspace-trip').hidden=!item.runtime_tenant_id;
  $('workspace-logging').checked=!!item.debug_logging_enabled;
  $('trip-report-text').hidden=true;$('trip-report-send').disabled=true;
  $('trip-report-status').textContent='Choose a service date to load its report.';
  manualCharges=[];renderManualCharges();clearManualCharge();
  $('business-workspace').hidden=false;$('business-workspace').scrollIntoView({behavior:'smooth'});
  if(item.runtime_tenant_id)void loadTripReport();
  void loadManualCharges();
}
$('workspace-close').addEventListener('click',()=>{selectedBusiness=null;$('business-workspace').hidden=true;});
$('workspace-logging').addEventListener('change',async()=>{
  if(!selectedBusiness)return;
  const enabled=$('workspace-logging').checked;
  $('workspace-logging').disabled=true;
  try{await api('business-debug-logging',{businessId:selectedBusiness.id,enabled});selectedBusiness.debug_logging_enabled=Number(enabled);$('trip-report-status').textContent=enabled?'Diagnostic logging enabled. New events should appear within a minute.':'Diagnostic logging paused. Existing reports remain available.';}
  catch(error){$('workspace-logging').checked=!enabled;$('trip-report-status').textContent=error.message.replaceAll('_',' ');}
  finally{$('workspace-logging').disabled=false;}
});
$('manual-charge-clear').addEventListener('click',clearManualCharge);
bind('manual-charge-form',async()=>{
  if(!selectedBusiness)throw new Error('Choose a business workspace first.');
  const form=$('manual-charge-form'),value=name=>form.elements.namedItem(name).value;
  const money=name=>Math.round(Number(value(name))*100);
  const data={businessId:selectedBusiness.id,serviceDate:value('serviceDate'),reference:value('reference'),title:value('title'),
    tripChargeCents:money('tripCharge'),waitingRateCentsPerHour:money('waitingRate'),
    billableWaitingMinutes:value('billableWaitingMinutes')===''?null:Number(value('billableWaitingMinutes')),
    passengerMiles:value('passengerMiles')===''?null:Number(value('passengerMiles')),
    insuranceMonthlyAssumptionCents:value('insuranceMonthlyAssumption')===''?null:money('insuranceMonthlyAssumption'),notes:value('notes')};
  if(editingCharge)Object.assign(data,{id:editingCharge.id,version:editingCharge.version});
  await api('manual-route-charge-save',data);clearManualCharge();await loadManualCharges();
  $('manual-charge-status').textContent='Manual route charge saved for this business. Subscriber accounting is unchanged.';
});
async function refresh(){
  const result=await api('dashboard');businesses=result.businesses;
  $('count-total').textContent=businesses.length;$('count-active').textContent=businesses.filter(b=>b.status==='ACTIVE').length;$('count-trial').textContent=businesses.filter(b=>b.status==='TRIAL').length;$('count-support').textContent=result.admins.filter(a=>a.role==='SUPPORT'&&a.state==='ACTIVE').length;
  renderBusinesses();$('team-list').replaceChildren();
  for(const person of result.admins){const li=document.createElement('li'),label=document.createElement('span');label.textContent=`${person.email} · ${person.role} · ${person.state}`;li.append(label);
    if(current.role==='OWNER'&&person.role==='SUPPORT'&&person.state!=='REVOKED'){const button=document.createElement('button');button.textContent='Revoke access';button.addEventListener('click',async()=>{if(!confirm(`Revoke ${person.email}'s access and active sessions?`))return;try{await api('revoke',{email:person.email});await refresh();message('Support access revoked.');}catch(error){message(error.message);}});li.append(button);}$('team-list').append(li);}
  $('audit-list').replaceChildren();for(const entry of result.audit){const li=document.createElement('li');li.textContent=`${new Date(entry.at).toLocaleString()} · ${entry.actor} · ${entry.action.replaceAll('_',' ')} · ${entry.target}`;$('audit-list').append(li);}
  await refreshFinance();
  await refreshCustomers();
}
$('search').addEventListener('input',renderBusinesses);
function clearEditor(){editing=null;$('business-form').reset();$('editor-title').textContent='Add a business';}
$('cancel-edit').addEventListener('click',clearEditor);
bind('business-form',async()=>{const data=Object.fromEntries(new FormData($('business-form')));if(editing)Object.assign(data,{id:editing.id,version:editing.version});await api('business',data);clearEditor();await refresh();message('Test business saved. Customer dispatch access and billing are unchanged.');});
bind('invite-form',async()=>{const result=await api('invite',{email:$('support-email').value});download('support-enrollment.json',JSON.stringify(result,null,2));$('invite-form').reset();await refresh();message('Enrollment file downloaded. Share it privately with that person; it expires in 24 hours.');});
setupCustomers({api,current:()=>current});
setupFinance({api,current:()=>current,companies:()=>businesses});
try{configuration=await api('config');$('challenge-status').textContent='Ready. Choose the enrollment file matching your email, then download a challenge.';$('environment').textContent=configuration.mode==='local'?'Local test: email ownership is not checked by Google/Cloudflare. Key and authenticator checks are enforced.':'Cloudflare Access identity, ML-DSA-65 signature, and authenticator verification.';try{await signedIn(await api('session'));}catch{showLogin();}}
catch(error){message(`Admin service unavailable: ${error.message}`);}
