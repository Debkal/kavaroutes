import {openStore} from '../src/store.mjs';
import {saveManualChargeEvent} from '../src/manual-charge-events.mjs';

const database=process.argv[2];
if(!database)throw new Error('DATABASE_PATH_REQUIRED');
const store=openStore(database);
try{
  const business=store.get("SELECT id,name FROM businesses WHERE id=? AND name='test_pony'",'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if(!business)throw new Error('TEST_PONY_BUSINESS_NOT_FOUND');
  const record={businessId:business.id,serviceDate:'2026-09-25',reference:'live-route-2026-09-25',
    title:'Illinois wheelchair van live two-leg trip',tripChargeCents:34000,waitingRateCentsPerHour:6500,
    billableWaitingMinutes:null,passengerMiles:29.04,insuranceMonthlyAssumptionCents:100000,
    notes:'Operator supplied $340 trip charge and $65 per waiting hour. Door-through-door assistance. Billable waiting minutes not confirmed; 29.04 GPS passenger miles measured across two legs.'};
  const existing=store.get('SELECT * FROM manual_route_charge_events WHERE business_id=? AND reference=?',business.id,record.reference);
  if(existing){
    if(existing.service_date!==record.serviceDate||existing.trip_charge_cents!==record.tripChargeCents||
      existing.waiting_rate_cents_per_hour!==record.waitingRateCentsPerHour||
      existing.insurance_monthly_assumption_cents!==record.insuranceMonthlyAssumptionCents)
      throw new Error('EXISTING_CHARGE_EVENT_DIFFERS_REVIEW_MANUALLY');
    console.log(`MANUAL_ROUTE_CHARGE_ALREADY_PRESENT ${existing.id}`);
  }else{
    const result=saveManualChargeEvent(store,'operator-import',record);
    console.log(`MANUAL_ROUTE_CHARGE_CREATED ${result.id}`);
  }
}finally{store.close();}
