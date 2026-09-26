import {randomUUID} from 'node:crypto';

const fail=(status,code)=>{throw Object.assign(new Error(code),{status,code});};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cents=(value,max,required=true)=>{
  if(!required&&value==null)return null;
  if(!Number.isSafeInteger(value)||value<0||value>max)fail(400,'INVALID_CHARGE_EVENT');
  return value;
};
const label=(value,max)=>{
  if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value))fail(400,'INVALID_CHARGE_EVENT');
  return value.trim();
};
function business(store,id){
  if(typeof id!=='string'||!uuid.test(id))fail(400,'INVALID_BUSINESS');
  if(!store.get('SELECT id FROM businesses WHERE id=?',id))fail(404,'BUSINESS_NOT_FOUND');
  return id;
}
function validDay(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||
    Number.isNaN(Date.parse(`${value}T12:00:00Z`))||new Date(`${value}T12:00:00Z`).toISOString().slice(0,10)!==value)fail(400,'INVALID_SERVICE_DATE');
  return value;
}
function fields(data){
  const reference=label(data.reference,80);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(reference))fail(400,'INVALID_CHARGE_EVENT');
  const passengerMiles=data.passengerMiles??null;
  if(passengerMiles!==null&&(!Number.isFinite(passengerMiles)||passengerMiles<0||passengerMiles>2000||Math.abs(Math.round(passengerMiles*100)-passengerMiles*100)>0.000001))fail(400,'INVALID_CHARGE_EVENT');
  const notes=data.notes??'';
  if(typeof notes!=='string'||notes.length>1000||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(notes))fail(400,'INVALID_CHARGE_EVENT');
  return {
    serviceDate:validDay(data.serviceDate),reference,title:label(data.title,160),
    tripChargeCents:cents(data.tripChargeCents,10_000_000),
    waitingRateCentsPerHour:cents(data.waitingRateCentsPerHour,1_000_000),
    billableWaitingMinutes:cents(data.billableWaitingMinutes,1440,false),
    insuranceMonthlyAssumptionCents:cents(data.insuranceMonthlyAssumptionCents,5_000_000,false),
    passengerMiles:passengerMiles===null?null:Math.round(passengerMiles*100)/100,
    notes:notes.trim(),
  };
}

export function initManualChargeEvents(store){store.db.exec(`CREATE TABLE IF NOT EXISTS manual_route_charge_events(
  id TEXT PRIMARY KEY,business_id TEXT NOT NULL REFERENCES businesses(id),service_date TEXT NOT NULL,
  reference TEXT NOT NULL,title TEXT NOT NULL,trip_charge_cents INTEGER NOT NULL,
  waiting_rate_cents_per_hour INTEGER NOT NULL,billable_waiting_minutes INTEGER,
  insurance_monthly_assumption_cents INTEGER,passenger_miles REAL,notes TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(business_id,reference));
  CREATE INDEX IF NOT EXISTS manual_route_charge_events_business_day
    ON manual_route_charge_events(business_id,service_date DESC,created_at DESC);`);}

export function manualChargeCatalog(store,businessId){
  business(store,businessId);
  return {businessId,events:store.all(`SELECT id,business_id AS businessId,service_date AS serviceDate,
    reference,title,trip_charge_cents AS tripChargeCents,waiting_rate_cents_per_hour AS waitingRateCentsPerHour,
    billable_waiting_minutes AS billableWaitingMinutes,insurance_monthly_assumption_cents AS insuranceMonthlyAssumptionCents,
    passenger_miles AS passengerMiles,notes,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt,version
    FROM manual_route_charge_events WHERE business_id=? ORDER BY service_date DESC,created_at DESC LIMIT 500`,businessId)};
}

export function saveManualChargeEvent(store,actor,data){
  const businessId=business(store,data.businessId),event=fields(data),now=Date.now();
  if(data.id!==undefined&&(typeof data.id!=='string'||!uuid.test(data.id)||!Number.isSafeInteger(data.version)||data.version<1))fail(400,'INVALID_CHARGE_EVENT');
  let id=data.id??randomUUID();
  store.transaction(()=>{
    if(data.id){
      const duplicate=store.get('SELECT id FROM manual_route_charge_events WHERE business_id=? AND reference=? AND id<>?',businessId,event.reference,id);
      if(duplicate)fail(409,'CHARGE_EVENT_REFERENCE_EXISTS');
      const result=store.run(`UPDATE manual_route_charge_events SET service_date=?,reference=?,title=?,trip_charge_cents=?,
        waiting_rate_cents_per_hour=?,billable_waiting_minutes=?,insurance_monthly_assumption_cents=?,passenger_miles=?,notes=?,
        updated_at=?,version=version+1 WHERE id=? AND business_id=? AND version=?`,
        event.serviceDate,event.reference,event.title,event.tripChargeCents,event.waitingRateCentsPerHour,
        event.billableWaitingMinutes,event.insuranceMonthlyAssumptionCents,event.passengerMiles,event.notes,
        now,id,businessId,data.version);
      if(!result.changes)fail(409,'CHARGE_EVENT_CHANGED_RELOAD');
    }else{
      if(store.get('SELECT id FROM manual_route_charge_events WHERE business_id=? AND reference=?',businessId,event.reference))fail(409,'CHARGE_EVENT_REFERENCE_EXISTS');
      store.run(`INSERT INTO manual_route_charge_events(id,business_id,service_date,reference,title,trip_charge_cents,
        waiting_rate_cents_per_hour,billable_waiting_minutes,insurance_monthly_assumption_cents,passenger_miles,notes,
        created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,businessId,event.serviceDate,event.reference,event.title,event.tripChargeCents,event.waitingRateCentsPerHour,
        event.billableWaitingMinutes,event.insuranceMonthlyAssumptionCents,event.passengerMiles,event.notes,actor,now,now);
    }
    store.audit(actor,data.id?'MANUAL_ROUTE_CHARGE_UPDATED':'MANUAL_ROUTE_CHARGE_CREATED',`${businessId}:${id}`);
  });
  return {id,businessId};
}
