import {useState} from 'react';
import {estimateRouteCost,validCostProfile,type RouteCostProfile} from '@kavaroutes/api-contracts/route-costing';
import {downloadCsv} from '../csv';

export function QuickQuote({profile,tripsPerMonth,version}:{profile:RouteCostProfile;tripsPerMonth:number;version:number}) {
 const [miles,setMiles]=useState(12),[minutes,setMinutes]=useState(45),[wait,setWait]=useState(0),[extra,setExtra]=useState(0);
 const [rides,setRides]=useState(1);
 const valid=validCostProfile(profile)&&[miles,minutes,wait,extra].every(Number.isFinite)&&miles>=0&&miles<=2000&&minutes>=0&&minutes<=1440&&wait>=0&&wait<=1440&&extra>=0&&extra<=100000;
 const estimate=valid?estimateRouteCost(profile,{miles,tripMinutes:minutes+wait,tripsPerMonth}):null;
 const cost=(estimate?.totalCents??0)+((estimate?.insuranceCents??0)+(estimate?.overheadCents??0))*(rides-1)+Math.round(extra*100);
 const price=Math.ceil(cost/(1-profile.targetMarginPercent/100));
 const money=(cents:number)=>`$${(cents/100).toFixed(2)}`;
 const exportQuote=()=>downloadCsv('kavaroutes-quote.csv',[
  ['Quote generated',new Date().toISOString()],['Profile version (current editable inputs)',version],
  ['One-way rides',rides],['Loaded miles',miles],['Paid driving / service minutes',minutes],['Paid waiting minutes',wait],['Other trip costs USD',extra],
  ['Fleet rides per month used',tripsPerMonth],['Estimated cost USD',(cost/100).toFixed(2)],['Suggested quote USD',(price/100).toFixed(2)],
  ['Target margin percent',profile.targetMarginPercent],...Object.entries(profile).map(([key,value])=>[key,String(value)])
 ]);
 return <section className="workspace-card" aria-label="Quick quote"><h2>Quick quote</h2>
  <p>Prepare a quote using the business costs below. Enter passenger miles for the full journey, including the return leg when applicable. Paid driving time should include travel to and from the client.</p>
  <div className="accounting-grid">
   <label>Journey<select value={rides} onChange={e=>setRides(Number(e.target.value))}><option value={1}>One way</option><option value={2}>Round trip (two rides)</option></select></label>
   <label>Loaded miles<input type="number" min="0" max="2000" step="0.1" value={miles} onChange={e=>setMiles(Number(e.target.value))}/></label>
   <label>Paid driving / service minutes<input type="number" min="0" max="1440" value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label>
   <label>Paid waiting minutes<input type="number" min="0" max="1440" value={wait} onChange={e=>setWait(Number(e.target.value))}/></label>
   <label>Other trip costs ($)<input type="number" min="0" max="100000" step="0.01" value={extra} onChange={e=>setExtra(Number(e.target.value))}/></label>
  </div>
  {valid?<p>Estimated cost <strong>{money(cost)}</strong> · Suggested quote <strong>{money(price)}</strong> · Target margin {profile.targetMarginPercent}%</p>:<p role="alert">Enter valid distances, times and costs.</p>}
  <p className="form-hint">Paid waiting is time the driver stays at the appointment. Other trip costs can include parking or tolls. Review the suggested price before sharing it; this estimate does not change agreed contract rates. Export a CSV to keep a record of the quote and its assumptions.</p>
  <button disabled={!valid} onClick={exportQuote}>Export quote CSV</button>
 </section>;
}
