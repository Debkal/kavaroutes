import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresFacilityService,createWp007Api,createSyntheticTestVerifier} from '../../dist/index.js';
import {withTenantTransaction} from '../../../postgres-persistence/dist/index.js';
export async function verifyFacilityDay(pool,tenantId,tripId,runtimeApp){
 const verifier=createSyntheticTestVerifier(),facility=await verifier.verify('Synthetic principal_facility'),other=randomUUID();
 const address=randomUUID();await pool.query("INSERT INTO intake.address(tenant_id,id,customer_label) VALUES($1,$2,'Synthetic facility test address')",[tenantId,address]);
 for(const id of [facility.subjectId,other])await pool.query("INSERT INTO intake.facility(tenant_id,id,address_id,synthetic_label) VALUES($1,$2,$3,'Synthetic facility') ON CONFLICT DO NOTHING",[tenantId,id,address]);
 const trip=(await pool.query('SELECT service_date::text FROM intake.trip_request WHERE tenant_id=$1 AND id=$2',[tenantId,tripId])).rows[0];
 const hiddenTrip=(await pool.query('SELECT id FROM intake.trip_request WHERE tenant_id=$1 AND id<>$2 ORDER BY id LIMIT 1',[tenantId,tripId])).rows[0].id;
 await pool.query('INSERT INTO intake.facility_trip_scope(tenant_id,facility_id,trip_id) VALUES($1,$2,$3),($1,$4,$5)',[tenantId,facility.subjectId,tripId,other,hiddenTrip]);
 const service=createPostgresFacilityService(pool),app=runtimeApp??await createWp007Api({facilityService:service});
 const prefix=`/v1/organizations/${tenantId}/facility`,headers={authorization:'Synthetic principal_facility'};
 try{
  const direct=await service.day({principal:facility,organizationId:tenantId,serviceDate:trip.service_date,limit:100});assert.equal(direct.items.length,1);
  const request={url:`${prefix}/days/${trip.service_date}`,headers};const page=await app.inject(request);assert.equal(page.statusCode,200,page.body);
  assert.equal(page.json().facilityReference,facility.subjectId);assert.equal(page.json().items.length,1);assert.equal(page.json().items[0].relatedTripReference,tripId);
  assert.equal(page.json().items[0].lifecycle,'COMPLETED');assert.equal(page.json().nextAfter,null);
  assert.deepEqual(Object.keys(page.json().items[0]).sort(),['lifecycle','relatedTripReference','scheduledAt']);
  assert.deepEqual((await app.inject({url:`${prefix}/trips/${tripId}`,headers})).json(),page.json().items[0]);
  assert.equal((await app.inject({url:`${prefix}/trips/${hiddenTrip}`,headers})).statusCode,404);
  assert.equal((await app.inject({url:`${prefix}/trips/${randomUUID()}`,headers})).statusCode,404);
  assert.equal((await app.inject({...request,headers:{}})).statusCode,401);
  for(const persona of ['principal_driver','principal_dispatcher','principal_outsider'])assert.equal((await app.inject({...request,headers:{authorization:`Synthetic ${persona}`}})).statusCode,404);
  assert.equal((await app.inject({...request,url:request.url+'?facilityId='+other})).statusCode,400);
  assert.equal((await app.inject({...request,url:request.url+'?limit=101'})).statusCode,400);
  for(const limit of ['0','-1','1.5','01','NaN','1&limit=2'])assert.equal((await app.inject({...request,url:request.url+'?limit='+limit})).statusCode,400);
  const different=await service.day({organizationId:tenantId,principal:{...facility,subjectId:other},serviceDate:trip.service_date,limit:100});assert.ok(different.items.every(t=>t.relatedTripReference!==tripId));
  await assert.rejects(()=>withTenantTransaction(pool,tenantId,'kavaroutes_api',db=>db.query('UPDATE intake.facility_trip_scope SET active=false WHERE tenant_id=$1',[tenantId])),e=>e.name==='PersistenceConflict'&&e.kind==='tenant');
  assert.equal((await pool.query('SELECT active FROM intake.facility_trip_scope WHERE tenant_id=$1 AND facility_id=$2 AND trip_id=$3',[tenantId,facility.subjectId,tripId])).rows[0].active,true);
  assert.equal((await withTenantTransaction(pool,'22222222-2222-4222-8222-222222222222','kavaroutes_api',db=>db.query('SELECT * FROM intake.facility_trip_scope'))).rowCount,0);
  const second=randomUUID();await pool.query(`INSERT INTO intake.trip_request(tenant_id,id,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,lifecycle_reference)
   SELECT tenant_id,$3,rider_id,service_date,service_timezone,local_service_time,resolved_service_at,resolved_utc_offset_seconds,ambiguity_policy,ambiguity_policy_version,'draft' FROM intake.trip_request WHERE tenant_id=$1 AND id=$2`,[tenantId,tripId,second]);
  await pool.query('INSERT INTO intake.facility_trip_scope(tenant_id,facility_id,trip_id) VALUES($1,$2,$3)',[tenantId,facility.subjectId,second]);
  const firstResponse=await app.inject({...request,url:request.url+'?limit=1'});assert.equal(firstResponse.statusCode,200,firstResponse.body);
  const firstPage=firstResponse.json();assert.equal(firstPage.items.length,1);assert.ok(firstPage.nextAfter);
  const secondResponse=await app.inject({...request,url:request.url+'?limit=1&after='+firstPage.nextAfter});assert.equal(secondResponse.statusCode,200,secondResponse.body);
  const secondPage=secondResponse.json();assert.equal(secondPage.items.length,1);assert.equal(secondPage.nextAfter,null);
  assert.deepEqual([...firstPage.items,...secondPage.items].map(t=>t.relatedTripReference).sort(),[tripId,second].sort());
  await pool.query('UPDATE intake.facility_trip_scope SET active=false,version=version+1 WHERE tenant_id=$1 AND facility_id=$2',[tenantId,facility.subjectId]);
  assert.deepEqual((await app.inject(request)).json().items,[]);assert.equal((await app.inject({url:`${prefix}/trips/${tripId}`,headers})).statusCode,404);
 }finally{if(!runtimeApp)await app.close();}
}
