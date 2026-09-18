import {describe,expect,it} from 'vitest';
import {clientHistoryRows,estimateRows,invoiceClaimRows} from '../src/csv';

const profile={fuelCentsPerGallon:416,fuelEfficiencyMpg:14,maintenanceCentsPerMile:15,driverHourlyCents:1800,
 driverBurdenPercent:30,insuranceCentsPerMonthPerVehicle:100000,fixedOverheadCentsPerMonth:80000,deadheadPercent:15,
 targetMarginPercent:18,contractedBaseCents:4500,contractedCentsPerMile:250};

describe('accounting exports',()=>{
 it('counts the estimate sheet and keeps the profile that produced it',()=>{
  const rows=estimateRows({day:'2026-09-17',profile,rows:[
   {label:'Alex Rider',serviceDate:'2026-09-17',plannedStartAt:'9:00 AM',miles:20,minutes:90,totalCents:5616,costPerMileCents:281,
    suggestedPriceCents:6849,contractedPriceCents:9500,marginAtContractedPercent:40.9,marginAdvice:'At or above the margin target you set for this work.'},
   {label:'Sam Rider',serviceDate:'2026-09-17',plannedStartAt:'10:00 AM',miles:10,minutes:45,totalCents:3933,costPerMileCents:393,
    suggestedPriceCents:4796,contractedPriceCents:7000,marginAtContractedPercent:43.8,marginAdvice:'At or above the margin target you set for this work.'}]});
  const summary=Object.fromEntries(rows.filter(row=>row.length===2).map(row=>[String(row[0]),row[1]]));
  expect(summary.Trips).toBe(2);
  expect(summary['Total miles']).toBe(30);
  expect(summary['Total cost cents']).toBe(9549);
  expect(summary['Total contracted cents']).toBe(16500);
  expect(summary['Total margin at contracted cents']).toBe(6951);
  expect(summary['Fuel cents per gallon']).toBe(416);
  expect(rows.find(row=>row[0]==='Trip')).toEqual(['Trip','Service date','Planned start','Miles','Minutes','Cost cents','Cost per mile cents',
   'Suggested price cents','Contracted cents','Margin at contracted percent','Margin advice']);
 });

 it('writes a claim packet with the payer fields and one line per billed trip',()=>{
  const rows=invoiceClaimRows({invoiceId:'11111111-1111-4111-8111-111111111111',clientLabel:'Audit Client',payerKind:'WORKERS_COMPENSATION',
   payerName:'Synthetic Comp Fund',claimReference:'CLM-1',periodStart:'2026-09-01',periodEnd:'2026-09-30',status:'SENT',
   totalCents:9000,totalMiles:20,forwardedAt:'2026-09-17T12:00:00.000Z',forwardedMethod:'PORTAL',forwardedTo:'payer.example',
   lines:[{ordinal:1,serviceDate:'2026-09-02',description:'100 Home Way → 200 Clinic Way',miles:10,hcpcsCode:'A0130',
     authorizationNumber:'PA-9',proofOfService:'SIGNATURE_ON_FILE',amountCents:4500},
    {ordinal:2,serviceDate:'2026-09-03',description:'100 Home Way → 200 Clinic Way',miles:10,hcpcsCode:'A0130',
     authorizationNumber:'PA-9',proofOfService:'SIGNATURE_ON_FILE',amountCents:4500}]});
  const header=Object.fromEntries(rows.filter(row=>row.length===2).map(row=>[String(row[0]),row[1]]));
  expect(header['Payer kind']).toBe('WORKERS_COMPENSATION');
  expect(header['Total charge cents']).toBe(9000);
  expect(header['Billed trips']).toBe(2);
  expect(String(header.Forwarded)).toMatch(/PORTAL/);
  expect(rows.filter(row=>row[0]===1||row[0]===2)).toHaveLength(2);
  expect(rows.at(-1)).toEqual(['Summary','Trips',2,'Unique line charges',1]);
 });

 it('counts a client history over the lookback the operator chose',()=>{
  const rows=clientHistoryRows({clientLabel:'Audit Client',days:90,trips:[
   {serviceDate:'2026-09-02',pickupLabel:'100 Home Way',dropoffLabel:'200 Clinic Way',plannedStartAt:'2026-09-02T16:00:00.000Z',
    appointmentLengthMinutes:60,tripState:'scheduled',executionState:'completed',driverLabel:'Driver 042',measuredMiles:11.4,proofCount:2},
   {serviceDate:'2026-08-30',pickupLabel:'100 Home Way',dropoffLabel:'300 Dialysis',plannedStartAt:'2026-08-30T16:00:00.000Z',
    appointmentLengthMinutes:45,tripState:'cancelled',executionState:'planned',driverLabel:null,measuredMiles:null,proofCount:0}],
   totals:{trips:2,delivered:1,cancelled:1,measuredMiles:11.4,appointmentMinutes:105,tripsWithProof:1}});
  const header=Object.fromEntries(rows.filter(row=>row.length===2).map(row=>[String(row[0]),row[1]]));
  expect(header['Lookback days']).toBe(90);
  expect(header.Delivered).toBe(1);
  expect(header['Measured miles (delivered)']).toBe(11.4);
  const detail=rows.filter(row=>row[0]==='2026-09-02'||row[0]==='2026-08-30');
  expect(detail).toHaveLength(2);
  expect(detail[1]!.at(-2)).toBe('');
 });
});
