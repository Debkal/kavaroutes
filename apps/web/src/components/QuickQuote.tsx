import {useState} from 'react';
import {estimateRouteCost,validCostProfile,type RouteCostProfile} from '@kavaroutes/api-contracts/route-costing';
import {downloadCsv} from '../csv';

export function QuickQuote({profile,tripsPerMonth,version}:{profile:RouteCostProfile;tripsPerMonth:number;version:number}) {
 const [miles,setMiles]=useState(12),[minutes,setMinutes]=useState(45),[wait,setWait]=useState(0),[extra,setExtra]=useState(0);
 const [tripCharge,setTripCharge]=useState(''),[waitingRate,setWaitingRate]=useState(''),[billableWait,setBillableWait]=useState(''),[insuranceScenario,setInsuranceScenario]=useState('');
 const [rides,setRides]=useState(1);
 const actualCharge=tripCharge===''?null:Number(tripCharge);
 const hourlyWaitingCharge=waitingRate===''?null:Number(waitingRate);
 const billedWaitingMinutes=billableWait===''?wait:Number(billableWait);
 const scenarioInsurance=insuranceScenario===''?null:Number(insuranceScenario);
 const scenarioProfile:RouteCostProfile=scenarioInsurance===null?profile:{...profile,insuranceCentsPerMonthPerVehicle:Math.round(scenarioInsurance*100)};
 const valid=validCostProfile(scenarioProfile)&&[miles,minutes,wait,extra].every(Number.isFinite)&&miles>=0&&miles<=2000&&minutes>=0&&minutes<=1440&&wait>=0&&wait<=1440&&extra>=0&&extra<=100000
  &&(actualCharge===null||(Number.isFinite(actualCharge)&&actualCharge>=0&&actualCharge<=100000))
  &&(hourlyWaitingCharge===null||(Number.isFinite(hourlyWaitingCharge)&&hourlyWaitingCharge>=0&&hourlyWaitingCharge<=10000))
  &&Number.isFinite(billedWaitingMinutes)&&billedWaitingMinutes>=0&&billedWaitingMinutes<=1440
  &&(scenarioInsurance===null||(Number.isFinite(scenarioInsurance)&&scenarioInsurance>=0&&scenarioInsurance<=5000));
 const estimate=valid?estimateRouteCost(scenarioProfile,{miles,tripMinutes:minutes+wait,tripsPerMonth}):null;
 const cost=(estimate?.totalCents??0)+((estimate?.insuranceCents??0)+(estimate?.overheadCents??0))*(rides-1)+Math.round(extra*100);
 const price=Math.ceil(cost/(1-profile.targetMarginPercent/100));
 const actualRevenue=actualCharge===null?null:Math.round(actualCharge*100)+Math.round((hourlyWaitingCharge??0)*billedWaitingMinutes/60*100);
 const actualMargin=actualRevenue===null||actualRevenue<=0?null:Math.round((actualRevenue-cost)/actualRevenue*1000)/10;
 const money=(cents:number)=>`$${(cents/100).toFixed(2)}`;
 const exportQuote=()=>downloadCsv('kavaroutes-quote.csv',[
  ['Quote generated',new Date().toISOString()],['Profile version (current editable inputs)',version],
  ['One-way rides',rides],['Loaded miles',miles],['Paid driving / service minutes',minutes],['Paid waiting minutes',wait],['Other trip costs USD',extra],
  ['Agreed trip charge before waiting USD',tripCharge],['Waiting charge per hour USD',waitingRate],['Billable waiting minutes',billedWaitingMinutes],
  ['Actual charge including waiting USD',actualRevenue===null?'':(actualRevenue/100).toFixed(2)],['Margin at actual charge percent',actualMargin??''],
  ['Fleet rides per month used',tripsPerMonth],['Insurance scenario USD per month per vehicle',scenarioInsurance??profile.insuranceCentsPerMonthPerVehicle/100],['Estimated cost USD',(cost/100).toFixed(2)],['Suggested quote USD',(price/100).toFixed(2)],
  ['Target margin percent',profile.targetMarginPercent],...Object.entries(scenarioProfile).map(([key,value])=>[key,String(value)])
 ]);
 return <section className="workspace-card" aria-label="Quick quote"><h2>Quick quote</h2>
  <p>Prepare a quote using the business costs below. Enter passenger miles for the full journey, including the return leg when applicable. Paid driving time should include travel to and from the client.</p>
  <div className="accounting-grid">
   <label>Journey<select value={rides} onChange={e=>setRides(Number(e.target.value))}><option value={1}>One way</option><option value={2}>Round trip (two rides)</option></select></label>
   <label>Loaded miles<input type="number" min="0" max="2000" step="0.1" value={miles} onChange={e=>setMiles(Number(e.target.value))}/></label>
   <label>Paid driving / service minutes<input type="number" min="0" max="1440" value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/></label>
   <label>Paid waiting minutes<input type="number" min="0" max="1440" value={wait} onChange={e=>setWait(Number(e.target.value))}/></label>
   <label>Agreed trip charge before waiting ($)<input type="number" min="0" max="100000" step="0.01" value={tripCharge} onChange={e=>setTripCharge(e.target.value)}/></label>
   <label>Waiting charge per hour ($)<input type="number" min="0" max="10000" step="0.01" value={waitingRate} onChange={e=>setWaitingRate(e.target.value)}/></label>
   <label>Billable waiting minutes<input type="number" min="0" max="1440" value={billableWait} placeholder={String(wait)} onChange={e=>setBillableWait(e.target.value)}/></label>
   <label>Insurance scenario ($/month/vehicle)<input type="number" min="0" max="5000" step="0.01" value={insuranceScenario} placeholder={String(profile.insuranceCentsPerMonthPerVehicle/100)} onChange={e=>setInsuranceScenario(e.target.value)}/></label>
   <label>Other trip costs ($)<input type="number" min="0" max="100000" step="0.01" value={extra} onChange={e=>setExtra(Number(e.target.value))}/></label>
  </div>
  {valid?<p>Estimated cost <strong>{money(cost)}</strong> · Suggested quote <strong>{money(price)}</strong> · Target margin {profile.targetMarginPercent}%</p>:<p role="alert">Enter valid distances, times and costs.</p>}
  {valid&&actualRevenue!==null?<p>Actual charge including waiting <strong>{money(actualRevenue)}</strong> · Estimated margin <strong>{actualMargin===null?'—':`${actualMargin}%`}</strong></p>:null}
  <p className="form-hint">Paid waiting is driver time; billable waiting may differ if the agreement rounds charges to a full hour. Leave billable minutes blank to use paid minutes. Insurance scenario changes only this quote; blank uses the business profile. Other trip costs can include parking or tolls. Review the suggested price before sharing it; this estimate does not change agreed contract rates. Export a CSV to keep a record of the quote and its assumptions.</p>
  <button disabled={!valid} onClick={exportQuote}>Export quote CSV</button>
 </section>;
}
