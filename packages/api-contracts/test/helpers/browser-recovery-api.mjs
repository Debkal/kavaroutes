import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresBrowserRecoveryService,createSyntheticTestVerifier} from '../../dist/index.js';

export async function verifyRecoveryCommand(app,tenantId,id,envelope,persona='principal_dispatcher'){
 const prefix=`/v1/organizations/${tenantId}/browser-commands`,headers={authorization:`Synthetic ${persona}`};
 const reserved=await app.inject({method:'POST',url:prefix,headers:{...headers,'idempotency-key':`browser-prepare-${id}`},payload:{id,envelope}});assert.equal(reserved.statusCode,200,reserved.body);
 const execute={method:'POST',url:`${prefix}/${id}/execute`,headers:{...headers,'idempotency-key':`browser-execute-${id}`},payload:{}};
 const applied=await app.inject(execute);assert.equal(applied.statusCode,200,applied.body);assert.equal(applied.json().result.outcome,'ACCEPTED',applied.body);
 assert.deepEqual((await app.inject(execute)).json(),applied.json());
 assert.deepEqual((await app.inject({url:prefix+'/pending',headers})).json().command,applied.json());
 const ack=await app.inject({method:'POST',url:`${prefix}/${id}/acknowledge`,headers:{...headers,'idempotency-key':`browser-acknowledge-${id}`},payload:{}});assert.equal(ack.statusCode,200,ack.body);
 return applied.json().result.body;
}

export async function verifyBrowserRecoveryApi(pool,tenantId,app){
 const prefix=`/v1/organizations/${tenantId}/browser-commands`,headers={authorization:'Synthetic principal_dispatcher'};
 const list=await app.inject({url:`/v1/organizations/${tenantId}/trips?limit=50`,headers});assert.equal(list.statusCode,200,list.body);assert.equal(list.json().page.limit,50);
 const id=randomUUID(),tripId=randomUUID(),rider=(await pool.query('SELECT id FROM intake.rider WHERE tenant_id=$1 LIMIT 1',[tenantId])).rows[0].id;
 const envelope={kind:'CREATE_TRIP',body:{tripId,riderId:rider,serviceDate:'2026-09-14',serviceTimezone:'America/Los_Angeles',localServiceTime:'09:00:00',resolvedServiceAt:'2026-09-14T16:00:00.000Z',resolvedUtcOffsetSeconds:-25200,ambiguityPolicy:'reject'}};
 const prepare=(payload,persona=headers)=>app.inject({method:'POST',url:prefix,headers:{...persona,'idempotency-key':`browser-prepare-${payload.id}`},payload});
 const command=(action,commandId=id,payload={})=>app.inject({method:'POST',url:`${prefix}/${commandId}/${action}`,headers:{...headers,'idempotency-key':`browser-${action}-${commandId}`},payload});
 assert.equal((await app.inject({url:prefix+'/pending'})).statusCode,401);
 for(const persona of ['principal_facility','principal_driver','principal_outsider']){const denied=await prepare({id,envelope},{authorization:'Synthetic '+persona});assert.equal(denied.statusCode,404,denied.body);}
 assert.equal((await prepare({id,envelope:{...envelope,url:'https://invalid.test'}})).statusCode,400);
 const reserved=await prepare({id,envelope});assert.equal(reserved.statusCode,200,reserved.body);assert.equal(reserved.json().result,null);
 assert.equal((await pool.query('SELECT id FROM intake.trip_request WHERE tenant_id=$1 AND id=$2',[tenantId,tripId])).rowCount,0,'preparing never creates a trip');
 assert.deepEqual((await app.inject({url:prefix+'/pending',headers})).json().command,reserved.json(),'lost reservation response is recoverable');
 assert.equal((await command('acknowledge')).statusCode,409);
 assert.equal((await prepare({id,envelope:{...envelope,body:{...envelope.body,tripId:randomUUID()}}})).statusCode,422);
 assert.equal((await prepare({id:randomUUID(),envelope})).statusCode,409);
 const accepted=await command('execute');assert.equal(accepted.statusCode,200,accepted.body);assert.equal(accepted.json().result.outcome,'ACCEPTED');assert.equal(accepted.json().result.body.tripId,tripId);
 const repeated=await command('execute');assert.deepEqual(repeated.json(),accepted.json(),'lost effect response replays original receipt');
 assert.equal((await pool.query('SELECT id FROM intake.trip_request WHERE tenant_id=$1 AND id=$2',[tenantId,tripId])).rowCount,1);
 assert.equal((await command('execute',id,{expectedVersion:999})).statusCode,400,'execution accepts no replacement body');
 assert.equal((await command('acknowledge')).statusCode,200);assert.equal((await app.inject({url:prefix+'/pending',headers})).json().command,null);
 assert.equal((await prepare({id,envelope})).json().acknowledged,true,'replayed old prepare cannot resurrect it');
 // A valid-shaped but wrong tag is a persisted rejection, not an unknown effect.
 const rejectedId=randomUUID(),cancel={kind:'CANCEL_TRIP',resourceId:tripId,expectedTag:'"kr1.'+'A'.repeat(43)+'"',body:{reasonCode:'SYNTHETIC_REQUESTER_CANCELLED'}};
 const reservedCancel=await prepare({id:rejectedId,envelope:cancel});assert.equal(reservedCancel.statusCode,200,reservedCancel.body);
 const rejected=await command('execute',rejectedId);assert.equal(rejected.statusCode,200,rejected.body);assert.equal(rejected.json().result.outcome,'REJECTED');assert.equal(rejected.json().result.statusCode,412);
 assert.deepEqual((await command('execute',rejectedId)).json(),rejected.json());await command('acknowledge',rejectedId);
 // Commit via the original domain endpoint, then simulate loss before the
 // recovery wrapper stores its receipt. Execution must reuse the same key.
 const crashId=randomUUID(),crashTrip=randomUUID(),crashEnvelope={...envelope,body:{...envelope.body,tripId:crashTrip}};
 assert.equal((await prepare({id:crashId,envelope:crashEnvelope})).statusCode,200);
 const original=await app.inject({method:'POST',url:`/v1/organizations/${tenantId}/trips`,headers:{...headers,'idempotency-key':`browser-command-${crashId}`},payload:crashEnvelope.body});assert.equal(original.statusCode,201,original.body);
 const recovered=await command('execute',crashId);assert.equal(recovered.statusCode,200,recovered.body);assert.deepEqual(recovered.json().result.body,original.json());
 assert.equal(Number((await pool.query('SELECT count(*) FROM platform.idempotency_record WHERE tenant_id=$1 AND operation_key=$2',[tenantId,`browser-command-${crashId}`])).rows[0].count),1);
 await command('acknowledge',crashId);
 const cancelled=await verifyRecoveryCommand(app,tenantId,randomUUID(),{kind:'CANCEL_TRIP',resourceId:crashTrip,expectedTag:original.headers.etag,body:{reasonCode:'SYNTHETIC_REQUESTER_CANCELLED'}});
 assert.equal(cancelled.trip.lifecycle,'CANCELLED');
 const principal=await createSyntheticTestVerifier().verify('Synthetic principal_dispatcher');
 const service=createPostgresBrowserRecoveryService(pool,{});
 await assert.rejects(()=>service.pending({organizationId:tenantId,principal:{...principal,capabilities:new Set()}}),e=>e.statusCode===404);
 await assert.rejects(()=>service.pending({organizationId:tenantId,principal:{...principal,branchScopes:new Set()}}),e=>e.statusCode===404);
 const expiredId=randomUUID(),expiredTrip=randomUUID(),expiredEnvelope={...envelope,body:{...envelope.body,tripId:expiredTrip}};
 await pool.query(`INSERT INTO platform.browser_command_recovery(tenant_id,actor_id,id,kind,envelope,created_at,expires_at)
  VALUES($1,$2,$3,'CREATE_TRIP',$4::jsonb,now()-interval '23 hours',now()-interval '1 hour')`,[tenantId,principal.id,expiredId,JSON.stringify(expiredEnvelope)]);
 const expired=await command('execute',expiredId);assert.equal(expired.statusCode,410,expired.body);assert.equal(expired.json().code,'RECOVERY_EXPIRED_REVIEW_REQUIRED');
 assert.equal((await command('acknowledge',expiredId)).statusCode,409);assert.equal((await prepare({id:randomUUID(),envelope})).statusCode,409);
 assert.equal((await pool.query('SELECT id FROM intake.trip_request WHERE tenant_id=$1 AND id=$2',[tenantId,expiredTrip])).rowCount,0);
}
