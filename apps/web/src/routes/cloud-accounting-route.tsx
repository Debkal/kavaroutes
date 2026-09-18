import {useEffect,useMemo,useState} from "react";
import {useQuery} from "@tanstack/react-query";
import {routeCostProfileDefaults, estimateRouteCost, defaultTripsPerMonth, type RouteCostProfile} from "@kavaroutes/api-contracts/route-costing";
import {DevelopmentApiError} from "@kavaroutes/api-contracts/private-development-transport";
import {createCloudAccountingApi} from "../cloud-accounting-api";
import {createCloudClientApi} from "../cloud-client-api";
import {clientHistoryRows, downloadCsv, estimateRows, invoiceClaimRows} from "../csv";
import {businessTimezone,businessToday} from "../business-time";
import {ServiceDatePicker} from "../components/ServiceDatePicker";

const LOOKBACKS = [30, 90, 180, 365, 1095] as const;
const PAYER_KINDS = ["MEDICAID","BROKER","MCO","COMMERCIAL_INSURANCE","WORKERS_COMPENSATION","AUTO_LIABILITY","FACILITY","PATIENT","OTHER"] as const;
const PROOF_KINDS = ["SIGNATURE_ON_FILE","FACILITY_SIGNATURE","DRIVER_ATTESTED","NOT_REQUIRED","MISSING"] as const;
const money = (cents:number)=>`$${(cents/100).toFixed(2)}`;
const moneyField = (label:string,value:number,onChange:(value:number)=>void,step=1)=>
 <label>{label} <input type="number" min={0} step={step} value={value} onChange={event=>onChange(Number(event.target.value))}/></label>;

/** Accounting: what a route costs and must be charged, which delivered trips are on an
 * invoice and where that invoice went, and a client's route history over a lookback the
 * operator chooses. */
export function Component(){
 const [serviceDate,setServiceDate]=useState(()=>businessToday());
 const [profile,setProfile]=useState<RouteCostProfile>(routeCostProfileDefaults);
 const [profileVersion,setProfileVersion]=useState(0);
 const [mileOverrides,setMileOverrides]=useState<Record<string,number>>({});
 const [message,setMessage]=useState("");
 const [busy,setBusy]=useState(false);
 const accounting=useMemo(()=>createCloudAccountingApi(window.location.origin,window.fetch.bind(window)),[]);
 const clients=useMemo(()=>createCloudClientApi(window.location.origin,window.fetch.bind(window)),[]);

 const stored=useQuery({queryKey:["accounting","cost-profile"],queryFn:({signal})=>accounting.costProfile(signal),retry:false});
 const estimates=useQuery({queryKey:["accounting","estimates",serviceDate],queryFn:({signal})=>accounting.estimates(serviceDate,signal),retry:false,refetchInterval:30000});
 const invoices=useQuery({queryKey:["accounting","invoices"],queryFn:({signal})=>accounting.invoices(50,signal),retry:false,refetchInterval:30000});
 const roster=useQuery({queryKey:["accounting","clients"],queryFn:({signal})=>clients.roster(undefined,signal),retry:false});
 const [clientId,setClientId]=useState("");
 const [lookback,setLookback]=useState<number>(90);
 const history=useQuery({queryKey:["accounting","history",clientId,lookback],queryFn:({signal})=>accounting.clientHistory(clientId,lookback,signal),enabled:!!clientId,retry:false});

 // A stored profile is the operator's own quote; the research defaults are only a
 // starting point, so the stored values replace them as soon as they load.
 useEffect(()=>{ if(stored.data?.value.profile){ setProfile(stored.data.value.profile); setProfileVersion(stored.data.value.version); } },[stored.data]);

 const trips=estimates.data?.value.trips??[];
 const rows=trips.map(trip=>{
  const miles=mileOverrides[trip.tripId]??trip.measuredMiles??profile.averageTripMiles;
  const plannedMinutes=Math.round((Date.parse(trip.plannedEndAt)-Date.parse(trip.plannedStartAt))/60_000)+trip.appointmentLengthMinutes;
  const estimate=estimateRouteCost(profile,{miles,tripMinutes:plannedMinutes,tripsPerMonth:defaultTripsPerMonth});
  return {trip,miles,minutes:plannedMinutes,estimate};
 });
 const totals=rows.reduce((sum,row)=>({miles:sum.miles+row.miles,cost:sum.cost+row.estimate.totalCents,
  suggested:sum.suggested+row.estimate.suggestedPriceCents,contracted:sum.contracted+row.estimate.contractedPriceCents,minutes:sum.minutes+row.minutes}),
  {miles:0,cost:0,suggested:0,contracted:0,minutes:0});

 const saveProfile=async()=>{
  setBusy(true);setMessage("");
  try{const receipt=await accounting.updateCostProfile(profile,profileVersion,`accounting-profile-${crypto.randomUUID()}`);
   setProfileVersion(receipt.value.version);setMessage(`Cost profile saved at version ${receipt.value.version}.`);await stored.refetch();}
  catch(error){setMessage(error instanceof DevelopmentApiError?`Cost profile not saved: ${error.code.replaceAll("_"," ").toLowerCase()}.`:"Cost profile not saved. Check the dispatch connection.");}
  finally{setBusy(false);}
 };
 const exportEstimates=()=>{
  downloadCsv(`kavaroutes-estimates-${serviceDate}.csv`,estimateRows({day:serviceDate,profile,
   rows:rows.map(row=>({label:row.trip.riderLabel??row.trip.clientLabel??row.trip.tripId.slice(0,8),serviceDate:row.trip.plannedStartAt.slice(0,10),
    plannedStartAt:new Date(row.trip.plannedStartAt).toLocaleString("en-US",{timeZone:businessTimezone}),miles:row.miles,minutes:row.minutes,
    totalCents:row.estimate.totalCents,costPerMileCents:row.estimate.costPerMileCents,suggestedPriceCents:row.estimate.suggestedPriceCents,
    contractedPriceCents:row.estimate.contractedPriceCents,marginAtContractedPercent:row.estimate.marginAtContractedPercent,
    marginAdvice:row.estimate.marginAdvice}))}));
  setMessage("Estimates exported.");
 };

 const [periodStart,setPeriodStart]=useState(()=>businessToday().slice(0,8)+"01");
 const [periodEnd,setPeriodEnd]=useState(()=>businessToday());
 const [payerKind,setPayerKind]=useState<string>("BROKER");
 const [payerName,setPayerName]=useState("Synthetic Broker");
 const [claimReference,setClaimReference]=useState("");
 const [hcpcsCode,setHcpcsCode]=useState("A0130");
 const [authorizationNumber,setAuthorizationNumber]=useState("");
 const [proofOfService,setProofOfService]=useState<string>("SIGNATURE_ON_FILE");
 const createInvoice=async()=>{
  setBusy(true);setMessage("");
  try{const receipt=await accounting.createInvoice({periodStart,periodEnd,clientId:clientId||null,payerKind,payerName,
   claimReference:claimReference.trim()||null,hcpcsCode:hcpcsCode.trim()||null,authorizationNumber:authorizationNumber.trim()||null,proofOfService},
   `accounting-invoice-${crypto.randomUUID()}`);
   setMessage(`Invoice created for ${receipt.value.lineCount} trip(s): ${money(receipt.value.totalCents)} over ${receipt.value.totalMiles} miles.`);
   await invoices.refetch();}
  catch(error){setMessage(error instanceof DevelopmentApiError?`Invoice not created: ${error.code.replaceAll("_"," ").toLowerCase()}.`:"Invoice not created. Check the dispatch connection.");}
  finally{setBusy(false);}
 };
 const [forwarding,setForwarding]=useState<string|null>(null);
 const [forwardMethod,setForwardMethod]=useState<string>("PORTAL");
 const [forwardTo,setForwardTo]=useState("");
 const forward=async(invoiceId:string,expectedVersion:number)=>{
  setBusy(true);setMessage("");
  try{const receipt=await accounting.forwardInvoice(invoiceId,{expectedVersion,method:forwardMethod,forwardedTo:forwardTo.trim()||payerName,
   claimReference:claimReference.trim()||null},`accounting-forward-${crypto.randomUUID()}`);
   setMessage(`Forwarding recorded (${forwardMethod}); invoice is ${receipt.value.status}.`);setForwarding(null);await invoices.refetch();}
  catch(error){setMessage(error instanceof DevelopmentApiError?`Forwarding not recorded: ${error.code.replaceAll("_"," ").toLowerCase()}.`:"Forwarding not recorded.");}
  finally{setBusy(false);}
 };
 const exportInvoice=async(invoiceId:string)=>{
  try{const full=(await accounting.invoice(invoiceId)).value;
   downloadCsv(`kavaroutes-claim-${invoiceId.slice(0,8)}.csv`,invoiceClaimRows(full));
   setMessage("Claim packet exported.");}
  catch{setMessage("Claim packet unavailable. Refresh and try again.");}
 };

 const clientOptions=roster.data?.value.clients??[];
 const historyValue=history.data?.value;
 const exportHistory=()=>{
  if(!historyValue)return;
  const label=clientOptions.find(client=>client.clientId===historyValue.clientId)?.displayName??historyValue.clientId.slice(0,8);
  downloadCsv(`kavaroutes-client-history-${historyValue.clientId.slice(0,8)}-${historyValue.days}d.csv`,
   clientHistoryRows({clientLabel:label,days:historyValue.days,trips:historyValue.trips,totals:historyValue.totals}));
  setMessage("Client history exported.");
 };

 return <main id="main-content" className="accounting-page">
  <section className="page-title"><div><p className="eyebrow">KavaRoutes · Accounting</p><h1>What the work costs and what it earns</h1>
   <p>Route estimates from your own rates, payer invoices built from delivered trips, and a client's route history over the lookback you choose.</p></div></section>
  <p role="status">{message}</p>
  {stored.isError&&<p role="alert">Cost profile unavailable. The estimates below use the built-in research defaults; save the profile to make them yours.</p>}

  <section className="workspace-card" aria-label="Route estimates">
   <div className="section-heading"><div><p className="eyebrow">Estimates</p><h2>Route estimates</h2>
    <p>Costs come from the profile below: fuel at the pump price you enter, maintenance per mile, the driver's paid time, insurance and fixed overhead spread across the month's trips, and the deadhead an empty leg adds. Suggested price is cost ÷ (1 − target margin).</p></div>
    <button disabled={!rows.length} onClick={exportEstimates}>Export estimates CSV</button></div>
   <ServiceDatePicker value={serviceDate} onChange={setServiceDate} disabled={busy}/>
   <details className="workspace-card"><summary>Cost profile (your quotes): fuel {profile.fuelCentsPerGallon}¢/gal, {profile.fuelEfficiencyMpg} mpg, driver ${(profile.driverHourlyCents/100).toFixed(2)}/h, target {profile.targetMarginPercent}%</summary>
    <div className="accounting-grid">
     {moneyField("Fuel cents per gallon",profile.fuelCentsPerGallon,value=>setProfile({...profile,fuelCentsPerGallon:value}))}
     {moneyField("Fuel efficiency (mpg)",profile.fuelEfficiencyMpg,value=>setProfile({...profile,fuelEfficiencyMpg:value}),0.1)}
     {moneyField("Maintenance cents per mile",profile.maintenanceCentsPerMile,value=>setProfile({...profile,maintenanceCentsPerMile:value}))}
     {moneyField("Driver hourly cents",profile.driverHourlyCents,value=>setProfile({...profile,driverHourlyCents:value}))}
     {moneyField("Driver burden percent",profile.driverBurdenPercent,value=>setProfile({...profile,driverBurdenPercent:value}),0.5)}
     {moneyField("Insurance cents per month per vehicle",profile.insuranceCentsPerMonthPerVehicle,value=>setProfile({...profile,insuranceCentsPerMonthPerVehicle:value}))}
     {moneyField("Fixed overhead cents per month",profile.fixedOverheadCentsPerMonth,value=>setProfile({...profile,fixedOverheadCentsPerMonth:value}))}
     {moneyField("Deadhead percent",profile.deadheadPercent,value=>setProfile({...profile,deadheadPercent:value}),0.5)}
     {moneyField("Target margin percent",profile.targetMarginPercent,value=>setProfile({...profile,targetMarginPercent:value}),0.5)}
     {moneyField("Contracted base cents",profile.contractedBaseCents,value=>setProfile({...profile,contractedBaseCents:value}))}
     {moneyField("Contracted cents per mile",profile.contractedCentsPerMile,value=>setProfile({...profile,contractedCentsPerMile:value}))}
     {moneyField("Average trip miles",profile.averageTripMiles,value=>setProfile({...profile,averageTripMiles:value}),0.5)}
     {moneyField("Loaded miles per hour",profile.loadedMilesPerHour,value=>setProfile({...profile,loadedMilesPerHour:value}),1)}
    </div>
    <p className="form-hint">Industry context for these inputs: fuel is $4.07–$4.37 a gallon nationally ($5.21–$6.02 on the West Coast); a NEMT van runs 12–16 mpg; maintenance runs $0.12–$0.18 a mile; a wheelchair driver costs $18–$25 an hour before a 25–40% burden; insurance is $565–$1,165 a month for a wheelchair van and up to $2,583 all-in in year one. Broker work nets 8–15%, private pay 20–35%, and a blended operation 12–22% — so 18% is the default target and 8% is the floor below which a broker trip is not worth running.</p>
    <button className="primary" disabled={busy} onClick={()=>void saveProfile()}>Save cost profile{profileVersion?` (version ${profileVersion})`:""}</button>
   </details>
   {estimates.isError&&<p role="alert">Estimates unavailable for this service date.</p>}
   {estimates.data&&!rows.length&&<p role="status">No trips are recorded on this service date.</p>}
   {rows.length>0&&<div className="table-scroll" tabIndex={0} role="group" aria-label="Route estimates, scrollable"><table>
    <caption>Cost, suggested price and the margin at your contracted rate</caption>
    <thead><tr><th scope="col">Trip</th><th scope="col">Start</th><th scope="col">Miles</th><th scope="col">Minutes</th><th scope="col">Cost</th>
      <th scope="col">Cost / mile</th><th scope="col">Suggested price</th><th scope="col">Contracted</th><th scope="col">Margin</th><th scope="col">Advice</th></tr></thead>
    <tbody>{rows.map(({trip,miles,minutes,estimate})=><tr key={trip.tripId}>
      <th scope="row">{trip.riderLabel??trip.clientLabel??trip.tripId.slice(0,8)}<small>{trip.pickupLabel} → {trip.dropoffLabel}{trip.measuredMiles===null?" · miles entered by hand":" · miles measured from the driver's trace"}</small></th>
      <td>{new Date(trip.plannedStartAt).toLocaleTimeString("en-US",{timeZone:businessTimezone,hour:"numeric",minute:"2-digit"})}</td>
      <td><input aria-label={`Miles for ${trip.riderLabel??trip.tripId}`} type="number" min={0} step={0.1} value={miles}
        onChange={event=>setMileOverrides({...mileOverrides,[trip.tripId]:Number(event.target.value)})}/></td>
      <td>{minutes}</td><td>{money(estimate.totalCents)}</td><td>{money(estimate.costPerMileCents)}</td>
      <td>{money(estimate.suggestedPriceCents)}</td><td>{money(estimate.contractedPriceCents)}</td>
      <td>{estimate.marginAtContractedPercent}%</td><td>{estimate.marginAdvice}</td></tr>)}</tbody>
    <tfoot><tr><th scope="row">Day totals</th><td/> <td>{Math.round(totals.miles*100)/100}</td><td>{totals.minutes}</td>
      <td>{money(totals.cost)}</td><td>{totals.miles?money(Math.round(totals.cost/totals.miles)):"—"}</td><td>{money(totals.suggested)}</td>
      <td>{money(totals.contracted)}</td><td>{totals.contracted?`${Math.round(((totals.contracted-totals.cost)/totals.contracted)*1000)/10}%`:"—"}</td><td/></tr></tfoot></table></div>}
  </section>

  <section className="workspace-card" aria-label="Payer invoices">
   <div className="section-heading"><div><p className="eyebrow">Invoices</p><h2>Payer invoices</h2>
    <p>An invoice bills the delivered trips in a period at your contracted rate. Export the claim packet and record where it was sent — insurance, workers' compensation, liability or the payer portal.</p></div>
    <button disabled={!invoices.data?.value.invoices.length} onClick={()=>void invoices.refetch()}>Refresh invoices</button></div>
   <div className="accounting-grid">
    <label>Period start <input type="date" value={periodStart} onChange={event=>setPeriodStart(event.target.value)}/></label>
    <label>Period end <input type="date" value={periodEnd} onChange={event=>setPeriodEnd(event.target.value)}/></label>
    <label>Client (optional) <select value={clientId} onChange={event=>setClientId(event.target.value)}><option value="">All clients</option>
      {clientOptions.map(client=><option key={client.clientId} value={client.clientId}>{client.displayName}</option>)}</select></label>
    <label>Payer kind <select value={payerKind} onChange={event=>setPayerKind(event.target.value)}>
      {PAYER_KINDS.map(kind=><option key={kind} value={kind}>{kind.replaceAll("_"," ").toLowerCase()}</option>)}</select></label>
    <label>Payer name <input value={payerName} onChange={event=>setPayerName(event.target.value)}/></label>
    <label>Claim reference <input value={claimReference} onChange={event=>setClaimReference(event.target.value)}/></label>
    <label>HCPCS code <input value={hcpcsCode} onChange={event=>setHcpcsCode(event.target.value)}/></label>
    <label>Authorization number <input value={authorizationNumber} onChange={event=>setAuthorizationNumber(event.target.value)}/></label>
    <label>Proof of service <select value={proofOfService} onChange={event=>setProofOfService(event.target.value)}>
      {PROOF_KINDS.map(kind=><option key={kind} value={kind}>{kind.replaceAll("_"," ").toLowerCase()}</option>)}</select></label>
   </div>
   <button className="primary" disabled={busy||!payerName.trim()} onClick={()=>void createInvoice()}>Create invoice from delivered trips</button>
   {invoices.isError&&<p role="alert">Invoices unavailable. Refresh before sending anything.</p>}
   {invoices.data&&<div className="table-scroll" tabIndex={0} role="group" aria-label="Payer invoices, scrollable"><table>
    <caption>Invoices, newest first</caption>
    <thead><tr><th scope="col">Invoice</th><th scope="col">Payer</th><th scope="col">Period</th><th scope="col">Trips</th><th scope="col">Total</th>
      <th scope="col">Miles</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
    <tbody>{invoices.data.value.invoices.map(invoice=><tr key={invoice.invoiceId}>
      <th scope="row">{invoice.invoiceId.slice(0,8)}<small>{invoice.clientLabel??"All clients"}{invoice.claimReference?` · claim ${invoice.claimReference}`:""}</small></th>
      <td>{invoice.payerName}<small>{invoice.payerKind.replaceAll("_"," ").toLowerCase()}</small></td>
      <td>{invoice.periodStart} → {invoice.periodEnd}</td><td>{invoice.lineCount}</td><td>{money(invoice.totalCents)}</td>
      <td>{invoice.totalMiles}</td>
      <td>{invoice.status}{invoice.forwardedAt?<small>{invoice.forwardedMethod} → {invoice.forwardedTo}</small>:null}</td>
      <td><button onClick={()=>void exportInvoice(invoice.invoiceId)}>Export claim CSV</button>
        {invoice.status!=="SENT"&&invoice.status!=="PAID"&&invoice.status!=="VOID"
          ?<button onClick={()=>setForwarding(forwarding===invoice.invoiceId?null:invoice.invoiceId)}>Forward to payer</button>:null}
        {forwarding===invoice.invoiceId&&<span className="accounting-forward">
          <label>Method <select value={forwardMethod} onChange={event=>setForwardMethod(event.target.value)}>
            <option value="PORTAL">Payer portal</option><option value="EMAIL">Email</option><option value="EXPORT">Export only</option><option value="POST">Post</option></select></label>
          <label>Sent to <input value={forwardTo} onChange={event=>setForwardTo(event.target.value)} placeholder={payerName}/></label>
          <button className="primary" disabled={busy} onClick={()=>void forward(invoice.invoiceId,invoice.aggregateVersion)}>Record forwarding</button></span>}
      </td></tr>)}</tbody></table></div>}
   {invoices.data&&!invoices.data.value.invoices.length&&<p role="status">No invoices yet.</p>}
  </section>

  <section className="workspace-card" aria-label="Client route history">
   <div className="section-heading"><div><p className="eyebrow">Clients</p><h2>Client route history</h2>
    <p>Every trip a client has been given, with the distance the driver's own trace measured and the appointment time it took. Choose how far back to look.</p></div>
    <button disabled={!historyValue} onClick={exportHistory}>Export history CSV</button></div>
   <div className="accounting-grid">
    <label>Client <select value={clientId} onChange={event=>setClientId(event.target.value)}><option value="">Choose client</option>
      {clientOptions.map(client=><option key={client.clientId} value={client.clientId}>{client.displayName}</option>)}</select></label>
    <label>Lookback <select value={lookback} onChange={event=>setLookback(Number(event.target.value))}>
      {LOOKBACKS.map(days=><option key={days} value={days}>{days===1095?"3 years":days===365?"1 year":`${days} days`}</option>)}</select></label>
   </div>
   {!clientId&&<p role="status">Choose a client to see their route history.</p>}
   {history.isError&&<p role="alert">Client history unavailable. No totals are shown rather than stale ones.</p>}
   {historyValue&&<>
    <p className="dispatch-summary" aria-label="Client history totals"><span><strong>{historyValue.totals.trips}</strong> trips</span>
      <span><strong>{historyValue.totals.delivered}</strong> delivered</span><span><strong>{historyValue.totals.cancelled}</strong> cancelled</span>
      <span><strong>{historyValue.totals.measuredMiles}</strong> measured miles</span>
      <span><strong>{historyValue.totals.appointmentMinutes}</strong> appointment minutes</span>
      <span><strong>{historyValue.totals.tripsWithProof}</strong> delivered with proof</span></p>
    <div className="table-scroll" tabIndex={0} role="group" aria-label="Client route history, scrollable"><table>
     <caption>Last {historyValue.days} days, newest first</caption>
     <thead><tr><th scope="col">Service date</th><th scope="col">Route</th><th scope="col">Appointment</th><th scope="col">State</th><th scope="col">Driver</th><th scope="col">Miles</th><th scope="col">Proofs</th></tr></thead>
     <tbody>{historyValue.trips.map(trip=><tr key={trip.tripId}>
       <th scope="row">{trip.serviceDate}<small>{new Date(trip.plannedStartAt).toLocaleTimeString("en-US",{timeZone:businessTimezone,hour:"numeric",minute:"2-digit"})}</small></th>
       <td>{trip.pickupLabel??"—"} → {trip.dropoffLabel??"—"}</td><td>{trip.appointmentLengthMinutes} min</td>
       <td>{trip.executionState.replaceAll("_"," ")}{trip.tripState==="cancelled"?" · cancelled":""}</td>
       <td>{trip.driverLabel??"—"}</td><td>{trip.measuredMiles===null?"—":trip.measuredMiles}</td><td>{trip.proofCount}</td></tr>)}</tbody></table></div>
   </>}
  </section>
 </main>;
}
